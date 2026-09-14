# fc-coordinator

The backend fc-mobile talks to: OIDC + DPoP edge, entitlements, collections and
sync, on Postgres only. It replaces fc-backend for the mobile client rather than
extending it — there is no password, no TOTP and no WebAuthn here, because
identity belongs to Authentik.

This repository currently holds **slice 1a**: the skeleton. Fastify 5 with a
single `GET /healthz`, the fc-shared telemetry baseline, the Postgres pool and
the first two migrations. OIDC, DPoP, the entitlement port and the Compare
pass-through are slice 1b.

## Requirements

- Node **>= 24.15.0** (inherited from the `@figurecollecting/fc-shared` BOM)
- Docker, for the migration test's Testcontainers Postgres
- A GitHub token with `read:packages` to install the private fc-shared package

## Install

```
NODE_AUTH_TOKEN=<read:packages PAT> npm ci
```

`.npmrc` maps the `@figurecollecting` scope to GitHub Packages and reads the
token from `NODE_AUTH_TOKEN`. It contains a placeholder, never a real token.

## Run

```
npm run dev      # tsx watch
npm run build    # tsc -> dist/ (ESM)
npm start        # node dist/server.js
```

| Variable | Default | Meaning |
|---|---|---|
| `COORDINATOR_PORT` | `5052` | listen port |
| `COORDINATOR_HOST` | `0.0.0.0` | listen address |
| `LOG_LEVEL` | `info` | trace / debug / info / warn / error / fatal / silent |
| `SERVICE_VERSION` | `unknown` | stamped into the image and reported by `/healthz` |
| `DATABASE_URL` | unset | full DSN; when unset the discrete `PG*` variables are used |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | libpq defaults | discrete connection settings |
| `PG_POOL_MAX` | `10` | pool size |
| `PGSSLMODE` | unset | `disable` \| `require` \| `verify-full`; production uses `verify-full` |
| `PGSSLROOTCERT` | unset | path to the CA PEM for `verify-full` (contents are read, not the path) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | collector endpoint; falls back to `OTEL_EXPORTER_OTLP_ENDPOINT` |

### Edge authentication (OIDC + DPoP)

Four variables are **required and have no default**. The process refuses to
start without them, which is deliberate: every plausible default is wrong in a
way that only shows up as an accepted token that should have been refused.

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_ISSUER` | **required** | Authentik issuer, pinned on every access token |
| `OIDC_AUDIENCE` | **required** | audience, pinned on every access token |
| `OIDC_JWKS_URI` | **required** | JWKS endpoint; must be `https` unless it is loopback |
| `COORDINATOR_PUBLIC_ORIGIN` | **required** | the origin every DPoP `htu` is compared against — never the `Host` header, which the caller controls |
| `OIDC_ALGORITHMS` | `RS256,ES256,PS256` | accepted access-token algorithms |
| `DPOP_ALGORITHMS` | `ES256,ES384,PS256,RS256` | accepted proof algorithms; symmetric and `none` are refused at startup |
| `DPOP_PROOF_MAX_AGE_SECONDS` | `30` | how old a proof's `iat` may be |
| `DPOP_CLOCK_SKEW_SECONDS` | `5` | how far into the future a proof's `iat` may be |
| `DPOP_NONCE_PERIOD_SECONDS` | `300` | nonce bucket rotation; the current and previous bucket are accepted |
| `DPOP_JTI_MAX_ENTRIES` | `100000` | hard cap on the in-memory replay window |
| `DPOP_REQUIRE_NONCE` | `true` | whether a proof must carry a nonce |
| `DEVICE_CACHE_TTL_SECONDS` | `5` | in-process cache of the device binding |

The `jti` replay window's TTL is **derived**, not configured: it is always
`DPOP_PROOF_MAX_AGE_SECONDS + DPOP_CLOCK_SKEW_SECONDS`. Letting an operator set
it independently invites a configuration where an evicted `jti` still names a
proof the `iat` check would accept.

**Routes.** `POST /auth/devices` enrols the key that signed the proof (first
sign-in) and is idempotent; `POST /auth/devices/:deviceId/revoke` sets
`revoked_at` and never deletes; `GET /auth/session` returns the verified
identity. Any other route opts in with `{ preHandler: app.dpopGuard }`, after
which `request.identity` carries `{ userId, deviceId, jkt }`.

**The `use_dpop_nonce` round trip.** Every guarded response carries a fresh
`DPoP-Nonce`, success or failure. A client with no nonce gets one `401` with
`WWW-Authenticate: DPoP error="use_dpop_nonce"` and retries the same request
once with the supplied nonce **and a fresh `jti`**. A client that refreshes the
nonce from every response never sees that 401 again, including across a bucket
roll. A coordinator restart invalidates every outstanding nonce by design — that
is what makes the empty replay cache after a restart unexploitable — so each
client pays exactly one extra round trip.

The port follows the estate scheme: the middle digit encodes the stage, so
test, dev and local-container are `5072`, `5092` and `5082`.

`OTEL_TRACES_EXPORTER=none` is **removed from the environment at startup**, by
design. It makes the SDK register a no-op provider whose trace id is all zeroes,
and fc-shared treats an all-zero id as "no span" — so every log line would
silently lose its trace tag. With no collector configured the service uses a
real span processor and a no-op *exporter* instead, which keeps trace ids real.

### Tracing

Inbound HTTP **is** instrumented (slice 1b closed the slice-1a gap). An
`onRequest` hook opens a `SERVER` span from the incoming `traceparent` and keeps
it active for the whole request, so every log line a handler emits carries
`trace=<id> span=<id>` joined to the caller's trace. Spans are named by route
TEMPLATE, never by concrete path, and `/healthz` opens no span at all.

Still open: the `traceparent` Connect **interceptors** (§A.5 rule 3), which
arrive with the first Connect hop.

## Health

`GET /healthz` returns 200 when the database answers and 503 when it does not.

```json
{
  "status": "ok",
  "service": "fc-coordinator",
  "version": "0.1.0",
  "db": { "reachable": true, "latencyMs": 1.4, "target": "pg-coord-rw.fc:5432/fccoord" },
  "otel": { "registered": true, "exporter": "otlp" }
}
```

The body never carries a credential: the target is stripped of its userinfo, and
a database failure is reported as the driver's error **code**, never its message
(a `pg` connection error routinely echoes the DSN).

## Test

```
npm test              # vitest run
npm run test:coverage # vitest run --coverage, gated at 85% line AND branch
```

The coverage gate lives in `vitest.config.ts`, so it fails locally on the same
thresholds CI uses. The migration suite starts a real `postgres:17-alpine`
through Testcontainers, creates a non-superuser migrator role, and runs the
actual `scripts/migrate.sh` against it. Docker must be running.

## Migrate

```
PGHOST=... PGUSER=<migrator> PGPASSWORD=... PGDATABASE=fccoord \
  npm run migrate
```

Numbered raw SQL plus `psql`, mirroring fc-aggregation's proven doctrine:

- each file commits **atomically with its ledger row** (`psql -1`), so a crash
  can never leave an applied-but-unrecorded migration;
- applied files are **immutable** — an edited file refuses the whole run;
- a back-dated numeric prefix refuses the whole run (fix forward, gaps are fine);
- transaction control inside a migration refuses the whole run: the runner owns
  the boundaries;
- it refuses to run as a **superuser** and refuses the maintenance databases;
- re-running is a no-op.

Exit codes: `0` success, `2` preflight refusal, `4` provenance refusal, `5`
transaction control in a pending file, `6` out-of-order file.

| Migration | Contents |
|---|---|
| `0001_identity.sql` | `app_user` (id **is** the Authentik uuid), `device` (DPoP `jkt` + public JWK, revoke-never-delete) |
| `0002_collection.sql` | `collection`, `holding` — the HOLDING layer; spine references are TEXT, never foreign keys |

## Shared baseline

`src/platform/shared.ts` is the **only** module that names
`@figurecollecting/fc-shared`, enforced by a test. It re-exports the trace,
redaction and logging surface and deliberately omits the legacy axios client,
fc-mobile's zustand stores and the Mongo-shaped `Figure`/`User` types.

It imports the **1.7.0 stateless subpaths** (`utils/trace`, `utils/sanitize`,
`utils/logger`), never the barrel. The barrel is a single bundle that also holds
the axios client for legacy fc-backend and fc-mobile's zustand stores, so taking
`getTraceContext` from it would load axios, zustand and react into a
Postgres-only service. `test/import-graph.test.ts` measures the real module
graph of the built output in a child process, using Node's own resolver, and
fails if any of the three is ever resolved again.

Those three packages are still **installed** — they remain fc-shared's declared
dependencies, so `npm ci` fetches them and they sit in the runtime image. What
1.7.0 buys is that nothing ever *loads* them. Removing them from the tree would
need fc-shared to make them optional or peer dependencies, which is a change to
that package, not to this one.

`tsconfig.json` `extends` the shipped `@figurecollecting/fc-shared/tsconfig.base.json`,
so the toolchain baseline is inherited mechanically rather than by convention.
**One field is overridden**: the base ships `module: ESNext` with
`moduleResolution: bundler`, which suits a library bundled by esbuild for
browsers. This is a Node ESM service run straight from `dist/`, so it uses
`nodenext` for both — `bundler` would type-check imports that Node then fails to
resolve at runtime. Everything else (target, strict, `esModuleInterop`,
`skipLibCheck`, `forceConsistentCasingInFileNames`) comes from the base.

## CI

The fork shift-left policy: fork **feature** branches run the full core CI, fork
`develop`/`main` mirrors run nothing, and the image build is org-only. A fork
run authenticates to GitHub Packages with a fork-held `read:packages` PAT in
`secrets.NODE_AUTH_TOKEN`; the org falls back to `GITHUB_TOKEN`.
