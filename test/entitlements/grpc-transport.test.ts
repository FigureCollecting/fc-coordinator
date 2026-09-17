/**
 * THE HOP ITSELF: the entitlement Check is a gRPC call, and this is where that
 * is asserted on a socket rather than in a comment.
 *
 * Ross's rule, 2026-09-17: "communications between all api endpoints … is to be
 * gRPC (with mTLS, whether homegrown, mesh, or both)". OpenFGA is one of the
 * estate's components for that rule (T-5) because a first-class gRPC API
 * exists — the REST endpoint this module used until now is a grpc-gateway
 * transcoding OF it, declared in the same proto. So the hop moves to the
 * PRIMARY definition; it does not adopt a second API.
 *
 * WHAT THE MESH ADDS AND WHAT IT DOES NOT. Inside the pod the call is cleartext
 * h2c to the mirrored service; the Linkerd proxy is what makes it mTLS on the
 * wire. Nothing in this directory can assert the mTLS half — that is R2/R3's
 * job, on a cluster — so what is asserted here is the half this repo owns: the
 * wire is HTTP/2 gRPC, the message is the generated openfga.v1 one, and the
 * credential travels as gRPC metadata.
 *
 * THE FAKE SPEAKS h2c AND NOTHING ELSE (see the helper): a client that quietly
 * fell back to HTTP/1.1 would fail to connect rather than pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  entitlementGrantCounters,
  grantsForSubject,
  resetEntitlementGrantsForTest,
} from '../../src/entitlements/grants.js';
import { resetOpenFgaTokenForTest } from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const MODEL = '01KXA5NRMNY7C8MZETNYXQT1CJ';
const TOKEN = 'static-test-token';
const T0 = 1_780_000_000_000;

let fga: FakeOpenFga;

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_GRPC_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_API_TOKEN: TOKEN,
    ...over,
  }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  fga = await startFakeOpenFga(() => true);
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await fga.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

describe('the Check reaches OpenFGA over gRPC', () => {
  it('grants on an explicit allowed:true, having dialled the gRPC method', async () => {
    const grants = await grantsForSubject(SUB, T0, env({ OPENFGA_MODEL_ID: MODEL }));

    expect(grants).toEqual(['inventory_levels']);
    expect(fga.calls).toHaveLength(1);
    // The RPC the server dispatched, which it could only have done from a
    // POST /openfga.v1.OpenFGAService/Check on an HTTP/2 stream.
    expect(fga.calls[0]?.method).toBe('Check');
  });

  it('sends the bearer as gRPC METADATA, not as an HTTP header on a JSON body', async () => {
    await grantsForSubject(SUB, T0, env());

    expect(fga.calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('asks the one question this module exists to ask', async () => {
    await grantsForSubject(SUB, T0, env({ OPENFGA_MODEL_ID: MODEL }));

    expect(fga.calls[0]).toMatchObject({
      storeId: STORE,
      user: `user:${SUB}`,
      relation: 'inventory_levels',
      object: 'app:figurecollecting',
      // Field FOUR on the wire. The slice reserves 5, which upstream gives to
      // `bool trace`; see test/entitlements/openfga-wire.test.ts.
      modelId: MODEL,
    });
  });

  it('honours OPENFGA_APP_OBJECT so a staging tenant stays a config change', async () => {
    await grantsForSubject(SUB, T0, env({ OPENFGA_APP_OBJECT: 'app:staging' }));

    expect(fga.calls[0]?.object).toBe('app:staging');
  });

  it('sends no model id when none is pinned, rather than an empty one', async () => {
    await grantsForSubject(SUB, T0, env());

    // proto3 has no presence on a scalar string: an unset field and an empty
    // one are the same bytes, which is what OpenFGA reads as "use the latest
    // model". The JSON body omitted the key; this is the same decision.
    expect(fga.calls[0]?.modelId).toBe('');
  });

  it('denies on an explicit allowed:false, and calls it a deny rather than an error', async () => {
    await fga.close();
    fga = await startFakeOpenFga(() => false);

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(entitlementGrantCounters()['deny']).toBe(1);
    expect(entitlementGrantCounters()['error']).toBeUndefined();
  });

  it('calls once per subject and serves the rest from the cache', async () => {
    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(SUB, T0 + 1, env());

    expect(fga.calls).toHaveLength(1);
    expect(entitlementGrantCounters()['cache_hit']).toBe(1);
  });
});
