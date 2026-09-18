/**
 * THE CHECK, AS AN AUTHENTICATED CALLER.
 *
 * openfga-token.test.ts proves the provider mints, caches, refreshes and fails
 * closed on its own. This file proves the Check USES it: that the bearer on the
 * wire is the minted one, that an `unauthenticated` buys exactly one re-mint
 * and not a loop, and — the property that keeps an operator honest — that a
 * failed mint stops the Check happening at all rather than sending it
 * unauthenticated.
 *
 * THE TRIGGER IS NOW A gRPC CODE, NOT A STATUS. The rule is unchanged and the
 * hinge moved: `Code.Unauthenticated` is what HTTP 401 was, and
 * `Code.PermissionDenied` is what 403 was. They are not interchangeable — one
 * says "I do not know who you are", which a fresh token can fix, and the other
 * says "I know, and no", which it cannot. Retrying the second is how a denial
 * becomes a mint storm.
 *
 * Both fakes are real sockets, so what is asserted is the request that went out,
 * not the one the code meant to make.
 */
import { Code } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantsForSubject, resetEntitlementGrantsForTest } from '../../src/entitlements/grants.js';
import {
  openFgaTokenCounters,
  resetOpenFgaTokenForTest,
} from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from '../helpers/fakeTokenEndpoint.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;

let fga: FakeOpenFga;
let idp: FakeTokenEndpoint;

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_GRPC_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: 'app-password',
    ...over,
  }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  fga = await startFakeOpenFga(() => true);
  idp = await startFakeTokenEndpoint();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await fga.close();
  await idp.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

describe('the Check under the OIDC credential', () => {
  it('sends the MINTED bearer, not a configured one', async () => {
    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual(['inventory_levels']);
    expect(idp.calls).toHaveLength(1);
    expect(fga.calls[0]?.authorization).toBe('Bearer token-1');
  });

  it('mints ONCE for a burst of distinct subjects', async () => {
    // Per-subject single-flight in the grant cache does not help here: these
    // are different subjects, so each is a separate Check. The TOKEN must still
    // be minted once, which is the provider's single-flight doing its job
    // through the Check rather than beside it.
    const subjects = [
      SUB,
      '1f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33',
      '2f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33',
      '3f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33',
    ];
    await Promise.all(subjects.map((s) => grantsForSubject(s, T0, env())));

    expect(fga.calls).toHaveLength(4);
    expect(idp.calls).toHaveLength(1);
  });

  it('never asks OpenFGA at all when the mint fails', async () => {
    // THE DISTINCTION THIS PROTECTS. Falling through to an unauthenticated
    // Check produces the same redacted read, and a 401 in the log that sends
    // an operator looking for a revoked grant instead of a missing Secret.
    idp.reply({ status: 500, body: { error: 'server_error' } });

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    expect(fga.calls).toHaveLength(0);
  });
});

describe('an `unauthenticated` from OpenFGA', () => {
  it('forces exactly ONE re-mint and then succeeds, if the new token is accepted', async () => {
    // The real shape of a rotation race: the cached token was valid when it was
    // cached and is not any more. The 401 applies to the FIRST call only, so
    // the retry meets a healthy OpenFGA — no timer, no race.
    fga.replyOnce({ code: Code.Unauthenticated });
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await grantsForSubject(SUB, T0, env())).toEqual(['inventory_levels']);
    expect(fga.calls).toHaveLength(2);
    expect(fga.calls[0]?.authorization).toBe('Bearer token-2');
    expect(fga.calls[1]?.authorization).toBe('Bearer token-2');
    expect(idp.calls).toHaveLength(2);
  });

  it('denies with an error after ONE retry — it never loops', async () => {
    fga.reply({ code: Code.Unauthenticated });

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    // Exactly two: the original and one retry. A loop would be unbounded.
    expect(fga.calls).toHaveLength(2);
    expect(idp.calls).toHaveLength(2);
    expect(openFgaTokenCounters()['token_mint']).toBe(2);
  });

  it('does NOT re-mint on the static path — there is nothing to re-mint', async () => {
    fga.reply({ code: Code.Unauthenticated });
    const staticEnv = {
      OPENFGA_GRPC_URL: fga.baseUrl,
      OPENFGA_STORE_ID: STORE,
      OPENFGA_API_TOKEN: 'preshared',
    } as NodeJS.ProcessEnv;

    const grants = await grantsForSubject(SUB, T0, staticEnv);

    expect(grants).toEqual([]);
    expect(fga.calls).toHaveLength(1);
    expect(fga.calls[0]?.authorization).toBe('Bearer preshared');
    expect(idp.calls).toHaveLength(0);
  });

  it('does not retry a permission_denied, which is a decision rather than a stale credential', async () => {
    fga.reply({ code: Code.PermissionDenied });

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(fga.calls).toHaveLength(1);
  });
});

describe('with no credential configured at all', () => {
  it('still calls OpenFGA, unauthenticated, exactly as before', async () => {
    // The documented local-dev shape. It is a DIFFERENT state from "a
    // credential was configured and could not be obtained", and the two must
    // not collapse into each other.
    const bare = { OPENFGA_GRPC_URL: fga.baseUrl, OPENFGA_STORE_ID: STORE } as NodeJS.ProcessEnv;

    expect(await grantsForSubject(SUB, T0, bare)).toEqual(['inventory_levels']);
    expect(fga.calls[0]?.authorization).toBeUndefined();
  });
});
