// The sync smoke against a coordinator that ACCEPTS contract 0.3.0's occ/{occ}/head and
// occ/{occ}/status, as WK-05b's will. WK-05b is not built, so its Push validation is stood in for
// here, for exactly those two families, from the schemas vendored out of fc-api-contract PR #8:
// the real Fastify app, the real Push transaction, the real feed and the real Delta do the rest.
// Every other key still goes through develop's validateEvent unchanged.
import { randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  DeltaRequestSchema,
  DeltaResponseSchema,
  PushOutcome,
  PushResponseSchema,
  SyncEventSchema,
  SyncOp,
  parseVersion,
} from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeviceStore } from '../../src/auth/plugin.js';
import { syncSmoke } from '../../scripts/phase2-client/smoke.js';
import { generateClientKey } from '../../scripts/phase2-client/dpop.js';
import { createSafeOutput } from '../../scripts/phase2-client/output.js';
import { Session } from '../../scripts/phase2-client/session.js';
import type { HttpRequest, HttpResponse } from '../../scripts/phase2-client/transport.js';
import { makeIssuer } from '../helpers/auth.js';
import { CLIENT_ID, buildCoordinator, injectTransport, recording, withStatus } from '../helpers/phase2Harness.js';
import { leaks, startRunEnv, type FullRun, type RunEnv } from '../helpers/phase2Run.js';

vi.mock('../../src/sync/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sync/validate.js')>();
  const occ = await import('../../scripts/phase2-client/occ030.js');
  const reject = (reason: string) => ({ ok: false as const, reason, userOwned: true });
  return {
    ...actual,
    validateEvent: (event: Parameters<typeof actual.validateEvent>[0], ctx: Parameters<typeof actual.validateEvent>[1]) => {
      const key = occ.OCC_SMOKE_KEY.exec(event.facetKey);
      if (key === null) return actual.validateEvent(event, ctx);
      const version = parseVersion(event.version);
      if (version === undefined || version.counter === null) return reject('version_malformed: stand-in');
      if (version.deviceId !== ctx.deviceHex) return reject('device_mismatch: stand-in');
      if (event.op === SyncOp.DELETE) return event.payload === '' ? { ok: true as const } : reject('payload_invalid: stand-in');
      try {
        occ.assertOccPayload(key.groups!['field'] as 'head' | 'status', event.payload);
      } catch {
        return reject('payload_invalid: stand-in');
      }
      return { ok: true as const };
    },
  };
});

let env: RunEnv;
let run: FullRun;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  env = await startRunEnv();
  run = await env.run();
}, 240_000);

afterAll(async () => {
  await env?.close();
  vi.restoreAllMocks();
});

const line = (id: string): string => run.stdout.split('\n').find((l) => l.startsWith(`${id} `)) ?? '';

describe('a whole run against a coordinator that takes the 0.3.0 occ keys', () => {
  it('passes the nine cases and the smoke, and exits 0', () => {
    expect(run.stdout).toMatch(/9 of 9 cases PASS; the sync smoke PASS/);
    expect(line('smoke')).toMatch(/^smoke +PASS Status, then one Push \(occ\/[0-9a-f-]{36}\/head, occ\/[0-9a-f-]{36}\/status: APPLIED\), then Delta from the Status cursor shows both/);
    expect(run.exit).toBe(0);
  });

  it('left the copy tombstoned and its head in place', async () => {
    const { rows } = await env.db.admin.query<{ facet_key: string; op: string }>(
      'SELECT facet_key, op FROM facet_state WHERE user_id = $1 ORDER BY facet_key',
      [run.userId],
    );
    expect(rows.map((r) => [r.facet_key.split('/').at(-1), r.op])).toEqual([
      ['head', 'upsert'],
      ['status', 'delete'],
    ]);
    expect(line('smoke')).toMatch(/cleanup: the copy's status tombstoned/);
  });

  it('still prints no token or JWK material', () => {
    expect(leaks(run.stdout + run.stderr, run.secrets)).toEqual([]);
  });
});

describe('the smoke, when the coordinator misbehaves', () => {
  let app: FastifyInstance;

  const smokeAgainst = async (rewrite: (req: HttpRequest, res: HttpResponse) => HttpResponse) => {
    const issuer = await makeIssuer({ audience: CLIENT_ID });
    app = buildCoordinator({ issuer, origin: 'https://api.test.invalid', devices: createDeviceStore(env.db.app), sync: env.db.app, logLines: [] });
    await app.ready();
    const transport = recording(injectTransport(() => app), [], rewrite);
    const session = new Session(transport, { origin: 'https://api.test.invalid', prefix: '/api' }, await issuer.mint({ sub: randomUUID() }), createSafeOutput({ write: () => true }, { write: () => true }));
    const primary = await generateClientKey();
    const deviceId = await session.enrol(primary, 'enrol');
    try {
      return await syncSmoke(
        { session, primary, primaryDeviceId: deviceId, generateKey: generateClientKey, now: Date.now, sleep: async () => {}, tokenExpiresAt: Date.now() + 600_000 },
      );
    } finally {
      await app.close();
    }
  };
  const on = (label: string, change: (res: HttpResponse) => HttpResponse) => (req: HttpRequest, res: HttpResponse) =>
    req.label === label ? change(res) : res;

  it('fails when Status does not answer', async () => {
    expect((await smokeAgainst(on('smoke:status', (res) => withStatus(res, 503, '{"code":"unavailable"}')))).detail).toMatch(/Status answered 503/);
  });

  it('fails when the Push does not answer', async () => {
    expect((await smokeAgainst(on('smoke:push', (res) => withStatus(res, 503, '{"code":"unavailable"}')))).detail).toMatch(/Push answered 503 unavailable/);
  });

  it('fails when Delta does not show what was pushed', async () => {
    // An empty DeltaResponse: no events, no more pages.
    const result = await smokeAgainst(on('smoke:delta', (res) => ({ ...res, body: new Uint8Array() })));
    expect(result).toMatchObject({ id: 'smoke', verdict: 'FAIL' });
    expect(result.detail).toMatch(/Delta from the Status cursor did not show/);
  });

  it('fails when Delta shows the keys and versions but not the bytes that were pushed', async () => {
    const result = await smokeAgainst(on('smoke:delta', (res) => {
      const page = fromBinary(DeltaResponseSchema, res.body);
      for (const event of page.events) if (event.payload !== '') event.payload = event.payload.replace('"tz":"', '"tz":"X');
      return { ...res, body: toBinary(DeltaResponseSchema, page) };
    }));
    expect(result).toMatchObject({ verdict: 'FAIL', detail: expect.stringMatching(/did not show .*head, .*status as pushed/) });
  });

  it('fails when Delta itself fails', async () => {
    expect((await smokeAgainst(on('smoke:delta', (res) => withStatus(res, 400, '{"code":"invalid_argument"}')))).detail).toMatch(/Delta answered 400/);
  });

  const pushAnswer = (results: { facetKey?: string; outcome: number; reason?: string }[]) => (res: HttpResponse): HttpResponse => ({
    ...res,
    status: 200,
    body: toBinary(PushResponseSchema, create(PushResponseSchema, { results: results.map((r) => ({ facetKey: r.facetKey ?? 'k', outcome: r.outcome as PushOutcome, reason: r.reason ?? '' })) })),
  });

  it('reads past a page of someone else\'s events to find its own', async () => {
    let first = true;
    const result = await smokeAgainst((req, res) => {
      if (req.label !== 'smoke:delta' || !first) return res;
      first = false;
      const asked = fromBinary(DeltaRequestSchema, req.body as Uint8Array);
      const foreign = create(SyncEventSchema, { facetKey: 'uf/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b/note', version: '2026-10-07T00:00:00.000000Z#0000000000#00000000000000000000000000000001', op: SyncOp.UPSERT, payload: '{}' });
      return { ...res, body: toBinary(DeltaResponseSchema, create(DeltaResponseSchema, { events: [foreign], hasMore: true, nextCursor: asked.cursor })) };
    });
    expect(result).toMatchObject({ verdict: 'PASS' });
  });

  it('names a rejection that is not the 0.2.x key refusal without blaming WK-05b', async () => {
    const result = await smokeAgainst(on('smoke:push', pushAnswer([{ outcome: PushOutcome.REJECTED, reason: 'device_mismatch: the version names another device' }, { outcome: PushOutcome.APPLIED }])));
    expect(result.detail).toMatch(/REJECTED device_mismatch/);
    expect(result.detail).not.toMatch(/WK-05b/);
  });

  it('fails when the Push answers for fewer events than it sent', async () => {
    expect((await smokeAgainst(on('smoke:push', pushAnswer([])))).detail).toMatch(/0 results for 2 events/);
  });

  it('names an outcome this client has no name for by its number', async () => {
    expect((await smokeAgainst(on('smoke:push', pushAnswer([{ outcome: 9 }, { outcome: 9 }])))).detail).toMatch(/outcome 9/);
  });

  it('fails when the cleanup tombstone is answered but not applied', async () => {
    expect((await smokeAgainst(on('smoke:push-cleanup', pushAnswer([{ outcome: PushOutcome.STALE }])))).detail).toMatch(/not applied \(STALE\)/);
    expect((await smokeAgainst(on('smoke:push-cleanup', pushAnswer([])))).detail).toMatch(/not applied \(no result\)/);
  });

  it('fails, after a passing smoke, when the cleanup tombstone is not applied', async () => {
    const result = await smokeAgainst(on('smoke:push-cleanup', (res) => withStatus(res, 503, '{"code":"unavailable"}')));
    expect(result).toMatchObject({ verdict: 'FAIL' });
    expect(result.detail).toMatch(/cleanup .*503/);
  });
});
