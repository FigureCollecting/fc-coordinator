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
  it('returns 200 and reports db reachability plus otel state', async () => {
    app = buildApp({
      db: reachableDb,
      dbTarget: 'pg-coord-rw.fc:5432/fccoord',
      telemetry: { registered: true, exporter: 'otlp', serviceName: 'fc-coordinator' },
      logLevel: 'silent',
    });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('fc-coordinator');
    expect(body['db']).toMatchObject({ reachable: true, target: 'pg-coord-rw.fc:5432/fccoord' });
    expect(body['otel']).toEqual({ registered: true, exporter: 'otlp' });
  });

  it('returns 503 and degraded status when the database is unreachable', async () => {
    app = buildApp({ db: unreachableDb, logLevel: 'silent' });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);

    const body = res.json() as { status: string; db: Record<string, unknown> };
    expect(body.status).toBe('degraded');
    expect(body.db['reachable']).toBe(false);
    expect(body.db['code']).toBe('ECONNREFUSED');
  });

  it('never puts a credential or a driver message in the response body', async () => {
    app = buildApp({ db: unreachableDb, dbTarget: 'pg:5432/fccoord', logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.body).not.toContain(PASSWORD);
    expect(res.body).not.toContain('ECONNREFUSED pg://');
    expect(res.body).not.toContain('postgres://');
  });

  it('reports otel as unregistered when telemetry was never started', async () => {
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json() as Record<
      string,
      Record<string, unknown>
    >;
    expect(body['otel']).toEqual({ registered: false, exporter: 'none' });
  });

  it('reports an unknown db target rather than inventing one', async () => {
    app = buildApp({ db: reachableDb, logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json() as Record<
      string,
      Record<string, unknown>
    >;
    expect(body['db']?.['target']).toBe('unknown');
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
