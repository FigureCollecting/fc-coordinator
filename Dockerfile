# Multi-stage Dockerfile for fc-coordinator.
# Stages: base (shared foundation) -> builder (compiles TS) -> production.
# CI targets `production`.
#
# Base image is node:24-slim (Debian bookworm) rather than fc-aggregation's
# node:26-alpine: the fc-shared BOM pins the runtime at Node >= 24.15.0 and this
# service is built and CI-tested on 24, so the image runs the version the tests
# ran on. Pinned EXACTLY — a floating tag silently changes the runtime.

# ============================================================================
# Base Stage
# ============================================================================
FROM node:24.21.0-slim AS base

# Cache-bust ARG to invalidate layers when security patches are needed.
ARG CACHE_BUST=2026-09-14-node24.21.0-npm11.19.1

WORKDIR /app

# Debian security patches + dumb-init (PID 1).
# Pin npm EXACTLY at 11.19.1: it bundles tar 7.5.22 (GHSA-r292-9mhp-454m fixed
# >= 7.5.21), while node 24.21.0's own bundled npm 11.19.0 ships vulnerable
# tar <= 7.5.20. A floating `npm@11` can resolve to a lagging version and
# silently revert the fix — pin exactly (fc-aggregation precedent).
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@11.19.1 && \
    npm cache clean --force

# .npmrc maps @figurecollecting to GitHub Packages; it carries only a
# ${NODE_AUTH_TOKEN} placeholder, never a real token.
COPY package*.json .npmrc ./

# ============================================================================
# Builder Stage — compiles TypeScript to ESM in dist/
# ============================================================================
FROM base AS builder

# Full install (incl. devDeps) for the build. The token arrives as a BuildKit
# secret mount — exposed only for this RUN, never written to a layer and never
# visible in `docker history`. --ignore-scripts blocks dependency lifecycle
# scripts (defence in depth).
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci --ignore-scripts

# .dockerignore excludes dist/ and node_modules/, so the build compiles fresh
# and never inherits a stale local dist/.
COPY . .

# The root package.json is type:module and tsc emits ESM, so dist/*.js is parsed
# as ESM by the SAME package.json — no dist/package.json shim is needed here
# (fc-aggregation needs one only because it emits CommonJS).
RUN npm run build

# ============================================================================
# Production Stage — minimal runtime
# ============================================================================
FROM node:24.21.0-slim AS production

ARG CACHE_BUST=2026-09-14-node24.21.0-npm11.19.1
ARG GITHUB_ORG=FigureCollecting
ARG GITHUB_REPO=fc-coordinator
ARG SERVICE_VERSION=0.0.0

LABEL org.opencontainers.image.title="Figure Collector Coordinator"
LABEL org.opencontainers.image.description="fc-mobile coordinator: OIDC + DPoP edge, entitlements, collections and sync on Postgres"
LABEL org.opencontainers.image.vendor="Figure Collector Services"
LABEL org.opencontainers.image.source="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}"
LABEL org.opencontainers.image.version="${SERVICE_VERSION}"

# Security patches, dumb-init, and the non-root runtime user (uid/gid 1001).
# npm is pinned here too, then removed further below.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@11.19.1 && \
    npm cache clean --force && \
    groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -M -s /usr/sbin/nologin fccoord

WORKDIR /app

COPY package*.json .npmrc ./

# Production dependencies only. Token via BuildKit secret mount — never a layer.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Compiled server, owned by root:root — read-only to the non-root user.
COPY --from=builder --chown=root:root /app/dist ./dist

# npm/npx are BUILD-TIME tools only (CMD is exec-form node; the healthcheck is
# node -e). Removing them drops npm's own bundled-dependency vulnerabilities and
# shrinks the runtime attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV COORDINATOR_PORT=5052
ENV SERVICE_VERSION=${SERVICE_VERSION}

USER fccoord

# 5052 follows the estate port scheme (backend 5050, frontend 5051); the middle
# digit encodes the stage, so test/dev/local-container are 5072/5092/5082.
EXPOSE 5052

# Real health route, unlike fc-aggregation's TCP-connect probe: /healthz reports
# database reachability and OTel state. Kubernetes gets its own probe in the
# manifests; this one is the Docker/Compose liveness signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=Number(process.env.COORDINATOR_PORT||5052);require('http').get({host:'127.0.0.1',port:p,path:'/healthz',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1));"

# dumb-init as PID 1 forwards SIGTERM/SIGINT so the graceful drain runs
# (app.close -> pool.end -> telemetry.shutdown -> exit 0). CMD is exec-form
# node — NEVER `npm start`, which would sit between dumb-init and node and break
# the signal path.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
