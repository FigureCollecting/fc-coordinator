// The nine proof-level cases, one at a time, against the REAL coordinator edge (buildApp, the test
// issuer, an in-memory device table) over app.inject. Each case is driven to PASS against the
// honest server, then to FAIL or INCONCLUSIVE against a server or an edge that misbehaves in the
// one way that case exists to catch. A verdict that cannot go red is not a verdict.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNonceEpoch } from '../../src/auth/nonce.js';
import type { DeviceStore } from '../../src/auth/plugin.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import {
  caseB1,
  caseB2,
  caseB3,
  caseB4,
  caseB5b,
  caseB6,
  caseB7,
  caseB8,
  caseB9b,
  preflight,
  type CaseContext,
} from '../../scripts/phase2-client/cases.js';
import { generateClientKey } from '../../scripts/phase2-client/dpop.js';
import { createSafeOutput } from '../../scripts/phase2-client/output.js';
import { Session } from '../../scripts/phase2-client/session.js';
import type { HttpRequest, HttpResponse, Transport } from '../../scripts/phase2-client/transport.js';
import { makeIssuer, type TestIssuer } from '../helpers/auth.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import {
  CLIENT_ID,
  buildCoordinator,
  injectTransport,
  memoryDevices,
  reasonsFor,
  recording,
  withStatus,
  type CoordinatorOptions,
} from '../helpers/phase2Harness.js';

const ORIGIN = 'https://api.test.invalid';
const PREFIX = '/api';
const B1_REQUEST = '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}';

let issuer: TestIssuer;
let spine: FakeSpineRead;
let app: FastifyInstance;
let devices: DeviceStore;
let logLines: string[];

beforeAll(async () => {
  issuer = await makeIssuer({ audience: CLIENT_ID });
  spine = await startFakeSpineRead({ keys: new Map() });
});
afterAll(async () => {
  await spine.close();
});

beforeEach(() => {
  logLines = [];
  devices = memoryDevices();
  // The ported entitlement module reports an unconfigured OpenFGA on the console by design.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

const coordinator = async (overrides: Partial<CoordinatorOptions> = {}): Promise<FastifyInstance> => {
  const built = buildCoordinator({ issuer, origin: ORIGIN, prefix: PREFIX, devices, logLines, spineUrl: spine.baseUrl, ...overrides });
  await built.ready();
  return built;
};

interface Harness {
  ctx: CaseContext;
  transport: Transport & { log: ReturnType<typeof recording>['log'] };
}

/** Sign in as one user, enrol a primary device, and hand back a case context. */
async function harness(
  options: { rewrite?: (req: HttpRequest, res: HttpResponse) => HttpResponse; tokenLifetimeMs?: number; overrides?: Partial<CoordinatorOptions> } = {},
): Promise<Harness> {
  app = await coordinator(options.overrides);
  const transport = recording(injectTransport(() => app), logLines, options.rewrite);
  const token = await issuer.mint({ sub: randomUUID() });
  const out = createSafeOutput({ write: () => true }, { write: () => true });
  const session = new Session(transport, { origin: ORIGIN, prefix: PREFIX }, token, out);
  const primary = await generateClientKey();
  const primaryDeviceId = await session.enrol(primary, 'enrol');
  return {
    transport,
    ctx: {
      session,
      primary,
      primaryDeviceId,
      generateKey: generateClientKey,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      tokenExpiresAt: Date.now() + (options.tokenLifetimeMs ?? 600_000),
    },
  };
}

const onLabel = (label: string, change: (res: HttpResponse) => HttpResponse) => (req: HttpRequest, res: HttpResponse) =>
  req.label === label ? change(res) : res;

describe('preflight', () => {
  it('passes against a coordinator: 401, a DPoP challenge and a DPoP-Nonce, with no credentials sent', async () => {
    app = await coordinator();
    const t = recording(injectTransport(() => app), logLines);
    expect(await preflight(t, { origin: ORIGIN, prefix: PREFIX })).toMatchObject({ verdict: 'PASS' });
    expect(t.log[0]!.request.headers).not.toHaveProperty('authorization');
    expect(t.log[0]!.request.headers).not.toHaveProperty('dpop');
    expect(t.log[0]!.request.url).toBe(`${ORIGIN}/api/auth/session`);
  });

  it('fails against anything that does not answer like the edge', async () => {
    app = await coordinator();
    const t = recording(injectTransport(() => app), logLines, (_req, res) => withStatus(res, 404));
    expect(await preflight(t, { origin: ORIGIN, prefix: PREFIX })).toMatchObject({ verdict: 'FAIL' });
    const noNonce = recording(injectTransport(() => app), logLines, (_req, res) => {
      const headers = new Headers(res.headers);
      headers.delete('dpop-nonce');
      return { ...res, headers };
    });
    expect((await preflight(noNonce, { origin: ORIGIN, prefix: PREFIX })).detail).toMatch(/DPoP-Nonce/);
  });
});

describe('B5b: retry with the returned nonce and a fresh jti', () => {
  it('passes: 401 use_dpop_nonce, then 200', async () => {
    const h = await harness();
    expect(await caseB5b(h.ctx)).toMatchObject({ id: 'B5b', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B5b:no-nonce')).toEqual(['nonce_missing']);
    const [first, retry] = h.transport.log.filter((e) => e.request.label.startsWith('B5b'));
    expect(first!.request.headers['dpop']).not.toBe(retry!.request.headers['dpop']);
  });

  it('fails when the coordinator does not ask for a nonce', async () => {
    const h = await harness({ overrides: { requireNonce: false } });
    expect(await caseB5b(h.ctx)).toMatchObject({ verdict: 'FAIL' });
  });

  it('fails when the retry is not accepted', async () => {
    const h = await harness({ rewrite: onLabel('B5b:retry', (res) => withStatus(res, 500)) });
    expect((await caseB5b(h.ctx)).detail).toMatch(/retry/);
  });
});

describe('B1: Compare, byte-identical to a direct call', () => {
  const direct = async (): Promise<Uint8Array> => {
    const res = await new SpineReadClient(spine.baseUrl, 5_000, []).compare({ gtin14: '04573102591234' }, '2026-09-14T12:00:00.000Z');
    return new TextEncoder().encode(res.resultJson);
  };

  it('passes when result_json matches the direct call byte for byte', async () => {
    const h = await harness();
    const result = await caseB1(h.ctx, { request: B1_REQUEST, reference: await direct() });
    expect(result).toMatchObject({ id: 'B1', verdict: 'PASS' });
    expect(result.detail).toMatch(/byte-identical/);
  });

  it('fails on a single differing byte', async () => {
    const h = await harness();
    const reference = await direct();
    reference[10] = reference[10]! ^ 1;
    expect((await caseB1(h.ctx, { request: B1_REQUEST, reference })).detail).toMatch(/differs from the reference .* at byte 10/);
  });

  it('fails on a shorter reference, naming where they part', async () => {
    const h = await harness();
    const reference = (await direct()).subarray(0, 20);
    expect((await caseB1(h.ctx, { request: B1_REQUEST, reference })).detail).toMatch(/at byte 20/);
  });

  it('is never a pass without the request or the reference', async () => {
    const h = await harness();
    expect(await caseB1(h.ctx, {})).toMatchObject({ verdict: 'INCONCLUSIVE' });
    expect(await caseB1(h.ctx, { request: B1_REQUEST })).toMatchObject({ verdict: 'INCONCLUSIVE' });
  });

  it('fails when Compare does not answer 200', async () => {
    const h = await harness({ overrides: { spineUrl: undefined } });
    expect((await caseB1(h.ctx, { request: B1_REQUEST, reference: new Uint8Array() })).detail).toMatch(/unavailable/);
  });
});

describe('B2: a valid token with no proof', () => {
  it('passes on 401 invalid_dpop_proof, which the coordinator logs as missing_proof', async () => {
    const h = await harness();
    expect(await caseB2(h.ctx)).toMatchObject({ id: 'B2', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B2')).toEqual(['missing_proof']);
    const sent = h.transport.log.find((e) => e.request.label === 'B2')!.request.headers;
    expect(sent['authorization']).toMatch(/^DPoP /);
    expect(sent).not.toHaveProperty('dpop');
  });

  it('fails when the edge lets it through', async () => {
    const h = await harness({ rewrite: onLabel('B2', (res) => withStatus(res, 200)) });
    expect(await caseB2(h.ctx)).toMatchObject({ verdict: 'FAIL' });
  });
});

describe('B3: a reused jti', () => {
  it('passes: the first use is accepted and the reuse is refused as jti_replayed', async () => {
    const h = await harness();
    expect(await caseB3(h.ctx)).toMatchObject({ id: 'B3', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B3:replay')).toEqual(['jti_replayed']);
  });

  it('fails when the first use is not accepted, and when the reuse is', async () => {
    let h = await harness({ rewrite: onLabel('B3:first', (res) => withStatus(res, 503)) });
    expect((await caseB3(h.ctx)).detail).toMatch(/first use/);
    await app.close();
    h = await harness({ rewrite: onLabel('B3:replay', (res) => withStatus(res, 200)) });
    expect(await caseB3(h.ctx)).toMatchObject({ verdict: 'FAIL' });
  });
});

describe('B4: a proof signed by another key', () => {
  it('passes: refused as key_not_bound while the enrolled key is accepted', async () => {
    const h = await harness();
    expect(await caseB4(h.ctx)).toMatchObject({ id: 'B4', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B4:stray')).toEqual(['key_not_bound']);
  });

  it('fails when the control is refused, and when the stray key is accepted', async () => {
    let h = await harness({ rewrite: onLabel('B4:control', (res) => withStatus(res, 401)) });
    expect((await caseB4(h.ctx)).detail).toMatch(/enrolled key/);
    await app.close();
    h = await harness({ rewrite: onLabel('B4:stray', (res) => withStatus(res, 200)) });
    expect(await caseB4(h.ctx)).toMatchObject({ verdict: 'FAIL' });
  });
});

describe('B9b: an htu naming the www host', () => {
  it('passes: refused as htu_mismatch, the proof naming www. and nothing else wrong', async () => {
    const h = await harness();
    expect(await caseB9b(h.ctx)).toMatchObject({ id: 'B9b', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B9b:www')).toEqual(['htu_mismatch']);
    const proof = h.transport.log.find((e) => e.request.label === 'B9b:www')!.request.headers['dpop']!;
    const htu = JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')).htu as string;
    expect(htu).toBe('https://www.api.test.invalid/api/auth/session');
  });

  it('fails when the control is refused, and when the www proof is accepted', async () => {
    let h = await harness({ rewrite: onLabel('B9b:control', (res) => withStatus(res, 401)) });
    expect(await caseB9b(h.ctx)).toMatchObject({ verdict: 'FAIL' });
    await app.close();
    h = await harness({ rewrite: onLabel('B9b:www', (res) => withStatus(res, 200)) });
    expect(await caseB9b(h.ctx)).toMatchObject({ verdict: 'FAIL' });
  });
});

describe('B8: a revoked device, beside a live one', () => {
  it('passes both halves: the revoked key is refused and the other device keeps working', async () => {
    const h = await harness();
    const result = await caseB8(h.ctx);
    expect(result).toMatchObject({ id: 'B8', verdict: 'PASS' });
    expect(reasonsFor(h.transport.log, 'B8:second-after')).toEqual(['key_not_bound']);
    expect(reasonsFor(h.transport.log, 'B8:primary-after')).toEqual([]);
  });

  it('fails each half on its own', async () => {
    let h = await harness({ rewrite: onLabel('B8:second-after', (res) => withStatus(res, 200)) });
    expect((await caseB8(h.ctx)).detail).toMatch(/revoked/);
    await app.close();
    h = await harness({ rewrite: onLabel('B8:primary-after', (res) => withStatus(res, 401)) });
    expect((await caseB8(h.ctx)).detail).toMatch(/other device/);
  });

  it('fails when the second device cannot be set up or revoked', async () => {
    let h = await harness({ rewrite: onLabel('B8:enrol-second', (res) => withStatus(res, 403)) });
    expect(await caseB8(h.ctx)).toMatchObject({ verdict: 'FAIL' });
    await app.close();
    h = await harness({ rewrite: onLabel('B8:second-before', (res) => withStatus(res, 401)) });
    expect(await caseB8(h.ctx)).toMatchObject({ verdict: 'FAIL' });
    await app.close();
    h = await harness({ rewrite: onLabel('B8:revoke', (res) => withStatus(res, 404)) });
    expect((await caseB8(h.ctx)).detail).toMatch(/revoke/);
  });
});

describe('B6: a nonce from the previous bucket, same epoch', () => {
  const PERIOD_S = 0.4;
  const PERIOD_MS = PERIOD_S * 1000;
  const stripNonce = (res: HttpResponse): HttpResponse => {
    const headers = new Headers(res.headers);
    headers.delete('dpop-nonce');
    return { ...res, headers };
  };

  it('passes: the nonce it captured is accepted once the bucket has rolled by one', async () => {
    const h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S } });
    const result = await caseB6(h.ctx, { periodMs: PERIOD_MS });
    expect(result).toMatchObject({ id: 'B6', verdict: 'PASS' });
    expect(result.detail).toMatch(/bucket \d+ presented in bucket \d+/);
    const captured = h.transport.log.find((e) => e.request.label === 'B6:capture')!.response!.headers.get('dpop-nonce')!;
    const presented = h.transport.log.filter((e) => e.request.label === 'B6').at(-1)!.request.headers['dpop']!;
    expect(JSON.parse(Buffer.from(presented.split('.')[1]!, 'base64url').toString('utf8')).nonce).toBe(captured);
  });

  it('fails when the previous-bucket nonce is refused, or the capture is', async () => {
    let h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S }, rewrite: onLabel('B6', (res) => withStatus(res, 401)) });
    expect(await caseB6(h.ctx, { periodMs: PERIOD_MS })).toMatchObject({ verdict: 'FAIL' });
    await app.close();
    h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S }, rewrite: onLabel('B6:capture', (res) => withStatus(res, 503)) });
    expect((await caseB6(h.ctx, { periodMs: PERIOD_MS })).detail).toMatch(/capturing/);
  });

  it('is inconclusive without a readable nonce, with the wrong period, or with too little token left', async () => {
    let h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S }, rewrite: onLabel('B6:capture', stripNonce) });
    expect(await caseB6(h.ctx, { periodMs: PERIOD_MS })).toMatchObject({ verdict: 'INCONCLUSIVE' });
    await app.close();
    h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S } });
    expect((await caseB6(h.ctx, { periodMs: 300_000 })).detail).toMatch(/period/);
    await app.close();
    h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S }, tokenLifetimeMs: 1_000 });
    expect((await caseB6(h.ctx, { periodMs: PERIOD_MS })).detail).toMatch(/expires/);
  });

  it('is inconclusive when the answer carries another epoch, and fails when it carries no nonce', async () => {
    const other = createNonceEpoch({ periodMs: PERIOD_MS });
    let h = await harness({
      overrides: { noncePeriodSeconds: PERIOD_S },
      rewrite: onLabel('B6', (res) => {
        const headers = new Headers(res.headers);
        headers.set('dpop-nonce', other.mint());
        return { ...res, headers };
      }),
    });
    expect((await caseB6(h.ctx, { periodMs: PERIOD_MS })).detail).toMatch(/restarted/);
    await app.close();
    h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S }, rewrite: onLabel('B6', stripNonce) });
    expect(await caseB6(h.ctx, { periodMs: PERIOD_MS })).toMatchObject({ verdict: 'FAIL' });
  });

  it('is inconclusive when the server is already two buckets on', async () => {
    const h = await harness({ overrides: { noncePeriodSeconds: PERIOD_S } });
    const slow: CaseContext = { ...h.ctx, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms + PERIOD_MS)) };
    expect((await caseB6(slow, { periodMs: PERIOD_MS })).detail).toMatch(/two buckets/);
  });

  it('waits again while the bucket has not rolled, then gives up', async () => {
    const h = await harness({ overrides: { noncePeriodSeconds: 30 } });
    // A client clock running a whole period ahead: every wait ends early and the bucket never rolls.
    const ahead: CaseContext = { ...h.ctx, now: () => Date.now() + 30_000, sleep: async () => {} };
    expect((await caseB6(ahead, { periodMs: 30_000 })).detail).toMatch(/did not roll/);
  });
});

describe('B7: a nonce across a restart', () => {
  const restartable = async (overrides: Partial<CoordinatorOptions> = {}) => {
    const h = await harness();
    const restart = async () => {
      await app.close();
      app = await coordinator(overrides);
    };
    return { h, restart };
  };
  const quick = { timeoutMs: 2_000, pollMs: 1, jtiWindowMs: 36_000 };

  it('passes both halves: refused on the nonce check, and the replay cache is empty', async () => {
    const { h, restart } = await restartable();
    const result = await caseB7(h.ctx, { ...quick, awaitRestart: restart });
    expect(result).toMatchObject({ id: 'B7', verdict: 'PASS' });
    const polls = h.transport.log.filter((e) => e.request.label === 'B7:poll');
    expect(polls.at(-1)!.reasons).toEqual(['nonce_invalid']);
    expect(reasonsFor(h.transport.log, 'B7:replayed-jti')).toEqual([]);
    const before = h.transport.log.find((e) => e.request.label === 'B7:before' && e.response?.status === 200)!;
    const replayed = h.transport.log.find((e) => e.request.label === 'B7:replayed-jti')!;
    const jti = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')).jti as string;
    expect(jti(replayed.request.headers['dpop']!)).toBe(jti(before.request.headers['dpop']!));
  });

  it('keeps polling through a dead socket and an answer with no nonce', async () => {
    const h = await harness();
    let calls = 0;
    const flaky: Transport = {
      count: 0,
      request: async (req) => {
        if (req.label === 'B7:poll') {
          calls += 1;
          if (calls === 1) throw new Error('socket hang up');
          if (calls === 2) return { status: 502, headers: new Headers(), body: new Uint8Array() };
        }
        return h.transport.request(req);
      },
    };
    const session = new Session(flaky, { origin: ORIGIN, prefix: PREFIX }, h.ctx.session.accessToken, createSafeOutput({ write: () => true }, { write: () => true }));
    const restart = async () => {
      await app.close();
      app = await coordinator();
    };
    expect(await caseB7({ ...h.ctx, session }, { ...quick, awaitRestart: restart })).toMatchObject({ verdict: 'PASS' });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('fails when the new process accepts an old-epoch nonce', async () => {
    const { h, restart } = await restartable();
    const lying = recording(h.transport, logLines, onLabel('B7:poll', (res) => (res.headers.get('dpop-nonce') !== null && res.status === 401 ? withStatus(res, 200) : res)));
    const session = new Session(lying, { origin: ORIGIN, prefix: PREFIX }, h.ctx.session.accessToken, createSafeOutput({ write: () => true }, { write: () => true }));
    expect((await caseB7({ ...h.ctx, session }, { ...quick, awaitRestart: restart })).detail).toMatch(/not 401 use_dpop_nonce/);
  });

  it('fails when the replayed jti is refused after the restart', async () => {
    const { h, restart } = await restartable();
    const lying = recording(h.transport, logLines, onLabel('B7:replayed-jti', (res) => withStatus(res, 401)));
    const session = new Session(lying, { origin: ORIGIN, prefix: PREFIX }, h.ctx.session.accessToken, createSafeOutput({ write: () => true }, { write: () => true }));
    expect((await caseB7({ ...h.ctx, session }, { ...quick, awaitRestart: restart })).detail).toMatch(/replay cache/);
  });

  it('fails when the request before the restart is refused', async () => {
    const h = await harness({ rewrite: onLabel('B7:before', (res) => withStatus(res, 503)) });
    expect(await caseB7(h.ctx, { ...quick, awaitRestart: async () => {} })).toMatchObject({ verdict: 'FAIL' });
  });

  it('is inconclusive when no restart is seen in time, or when the replayed jti is too old to prove anything', async () => {
    let h = await harness();
    expect((await caseB7(h.ctx, { ...quick, timeoutMs: 30, pollMs: 5, awaitRestart: async () => {} })).detail).toMatch(/no restart/);
    await app.close();
    const r = await restartable();
    h = r.h;
    expect((await caseB7(h.ctx, { ...quick, jtiWindowMs: 0, awaitRestart: r.restart })).detail).toMatch(/window/);
  });
});
