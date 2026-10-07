// The sync smoke against a coordinator that ACCEPTS contract 0.3.0's occ/{occ}/head and
// occ/{occ}/status, as WK-05b's will. WK-05b is not built, so its Push validation is stood in for
// here, for exactly those two families, from the schemas vendored out of fc-api-contract PR #8:
// the real Fastify app, the real Push transaction, the real feed and the real Delta do the rest.
// Every other key still goes through develop's validateEvent unchanged.
import { randomUUID } from 'node:crypto';
import { SyncOp, parseVersion } from '@figurecollecting/fc-api-contract';
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

  it('fails when Delta itself fails', async () => {
    expect((await smokeAgainst(on('smoke:delta', (res) => withStatus(res, 400, '{"code":"invalid_argument"}')))).detail).toMatch(/Delta answered 400/);
  });

  it('fails, after a passing smoke, when the cleanup tombstone is not applied', async () => {
    const result = await smokeAgainst(on('smoke:push-cleanup', (res) => withStatus(res, 503, '{"code":"unavailable"}')));
    expect(result).toMatchObject({ verdict: 'FAIL' });
    expect(result.detail).toMatch(/cleanup .*503/);
  });
});
