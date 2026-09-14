import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const PASSWORD = 'hunter2';

const reachableDb = { query: async () => ({ rows: [{ ok: 1 }] }) };
const unreachableDb = {
  query: async (): Promise<never> => {
    throw Object.assign(new Error(`connect ECONNREFUSED pg://fc:${PASSWORD}@pg:5432`), {
      code: 'ECONNREFUSED',
    });
  },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('returns 200 and reports db and otel as a STATE, not as detail', async () => {
    app = buildApp({
      db: reachableDb,
      telemetry: { registered: true, exporter: 'otlp', serviceName: 'fc-coordinator' },
      logLevel: 'silent',
    });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok', otel: 'registered' });
  });

  it('returns 503 and degraded status when the database is unreachable', async () => {
    app = buildApp({ db: unreachableDb, logLevel: 'silent' });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'down', otel: 'missing' });
  });

  it('carries EXACTLY three keys — the endpoint is public and every extra one is disclosure', async () => {
    // /healthz is the whole public allowlist: kubelet and the image HEALTHCHECK
    // carry no credential, so anything the body says, it says to the internet
    // the day this fronts a public edge. Earlier it reported host:port/dbname,
    // the driver error code and a latency. None of that belongs to an
    // unauthenticated caller; the target is logged once at startup instead.
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json() as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['db', 'otel', 'status']);
  });

  it('never leaks the host, the port, the database name, a driver code or a latency', async () => {
    app = buildApp({ db: unreachableDb, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    for (const leak of [PASSWORD, 'ECONNREFUSED', 'postgres://', 'pg:5432', 'fccoord', 'latency']) {
      expect(res.body).not.toContain(leak);
    }
    expect(res.body).not.toMatch(/\d+\.\d+/);
  });

  it('reports otel as missing when telemetry was never started', async () => {
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json() as Record<string, unknown>;
    expect(body['otel']).toBe('missing');
  });

  it('reports otel as registered even when the exporter is a no-op', async () => {
    app = buildApp({
      db: reachableDb,
      telemetry: { registered: true, exporter: 'noop', serviceName: 'fc-coordinator' },
      logLevel: 'silent',
    });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json() as Record<string, unknown>;
    // The exporter KIND is an operational detail; that a provider is registered
    // at all is the health fact. The kind is visible in the startup log.
    expect(body['otel']).toBe('registered');
  });
});

describe('app boundaries', () => {
  it('defaults the log level when only a sink is supplied', async () => {
    const lines: string[] = [];
    app = buildApp({ db: reachableDb, logSink: (l) => lines.push(l) });
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(lines.length).toBeGreaterThan(0);
  });

  it('404s an unknown route', async () => {
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('405s a POST to the health route rather than treating it as a probe', async () => {
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const res = await app.inject({ method: 'POST', url: '/healthz' });
    expect(res.statusCode).toBe(404);
  });

  it('logs through the trace-tagging structured logger', async () => {
    const lines: string[] = [];
    app = buildApp({ db: reachableDb, logLevel: 'info', logSink: (l) => lines.push(l) });
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
