/**
 * THE BOOT LINE, AND THE BOOT REFUSAL.
 *
 * TWO THINGS AN OPERATOR NEEDS AT STARTUP AND CAN GET NOWHERE ELSE. The first
 * is which WIRE the Check runs on: `initOpenFgaAuth` has always said which
 * credential is in use, and after this unit the credential is only half the
 * answer. A line that names the transport is how "the hop is gRPC now" stops
 * being a claim in a commit message and becomes something visible in a pod log.
 *
 * The second is the REFUSAL, and it is the more important of the two. The
 * variable was renamed — `OPENFGA_API_URL` to `OPENFGA_GRPC_URL` — and a rename
 * has a silent failure mode: a manifest that was not updated keeps setting the
 * old name, the new one is unset, and the module reports itself unconfigured.
 * Every read comes back redacted, the operator sees a variable they believe is
 * in use, and the transport rule is quietly half-applied. There is no state in
 * which that is better than not starting.
 *
 * SO IT THROWS, and it throws at BOOT rather than on the first read, because a
 * process that dies at startup is a deployment that visibly failed while a
 * process that denies every read is a deployment that appears to have worked.
 *
 * AND THE MODULE REFUSES IT AGAIN ON THE CALL PATH. The boot check is host
 * wiring and a host can skip it — `registerConnect` does exactly that under
 * `initSigning: false`. A guard that only exists in the wiring is a guard the
 * next host will not inherit, so grants.ts declines the same configuration on
 * its own, without a socket being opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantsForSubject,
  initOpenFgaTransport,
  resetEntitlementGrantsForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import { resetOpenFgaTokenForTest } from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;

let logged: string[];
let events: EntitlementAuditEvent[];

const line = (): string => logged.join('\n');

beforeEach(() => {
  logged = [];
  events = [];
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  setEntitlementAuditSink((e) => events.push(e));
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
  }
});

afterEach(() => {
  setEntitlementAuditSink(null);
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

describe('the boot line names the transport', () => {
  it('says grpc h2c and the authority it will dial', () => {
    const endpoint = 'http://openfga-mc-fc-ha.authz.svc.cluster.local:8081';

    expect(initOpenFgaTransport({ OPENFGA_GRPC_URL: endpoint } as NodeJS.ProcessEnv)).toBe(endpoint);

    expect(line()).toContain('openfga: grpc h2c openfga-mc-fc-ha.authz.svc.cluster.local:8081');
  });

  it('does not call an https endpoint h2c, because h2c means cleartext', () => {
    // The distinction is the reason the line is worth printing at all. Inside
    // the mesh the hop IS cleartext and the proxy adds mTLS; a line that called
    // an https endpoint "h2c" would be the sentence someone quotes to show a
    // hop was meshed when it was not.
    initOpenFgaTransport({ OPENFGA_GRPC_URL: 'https://openfga.example:8081' } as NodeJS.ProcessEnv);

    expect(line()).toContain('openfga: grpc h2 tls openfga.example:8081');
    expect(line()).not.toContain('h2c');
  });

  it('warns, rather than logging nothing, when no endpoint is configured', () => {
    expect(initOpenFgaTransport({} as NodeJS.ProcessEnv)).toBe('');

    expect(line()).toContain('OPENFGA_GRPC_URL unset');
    expect(line()).toContain('every entitlement check denies');
  });

  it('says what was configured even when it cannot be parsed', () => {
    initOpenFgaTransport({ OPENFGA_GRPC_URL: 'not a url' } as NodeJS.ProcessEnv);

    // Never the raw value: an endpoint is a place where someone eventually puts
    // a credential by mistake, and this line is the one that would print it.
    expect(line()).toContain('(unparseable)');
    expect(line()).not.toContain('not a url');
  });
});

describe('the retired REST variable', () => {
  it('refuses to boot, naming the rename', () => {
    expect(() =>
      initOpenFgaTransport({
        OPENFGA_API_URL: 'http://openfga-mc-fc-ha.authz.svc.cluster.local:8080',
        OPENFGA_GRPC_URL: 'http://openfga-mc-fc-ha.authz.svc.cluster.local:8081',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPENFGA_GRPC_URL/);
  });

  it('refuses even when it is the ONLY endpoint set — no silent fallback to REST', () => {
    // The shape an un-updated manifest actually has. A module that treated this
    // as "the endpoint, on the old variable name" would put the hop straight
    // back on HTTP, which is the one outcome this unit must make impossible.
    expect(() =>
      initOpenFgaTransport({ OPENFGA_API_URL: 'http://openfga:8080' } as NodeJS.ProcessEnv),
    ).toThrow(/no HTTP path/);
  });

  it('denies on the call path too, and dials nothing', async () => {
    const fga: FakeOpenFga = await startFakeOpenFga(() => true);
    try {
      const grants = await grantsForSubject(SUB, T0, {
        OPENFGA_API_URL: 'http://openfga:8080',
        OPENFGA_GRPC_URL: fga.baseUrl,
        OPENFGA_STORE_ID: STORE,
      } as NodeJS.ProcessEnv);

      expect(grants).toEqual([]);
      // Not a socket opened. The configuration is refused before anything is
      // asked, so this cannot be mistaken for OpenFGA having denied.
      expect(fga.calls).toHaveLength(0);
      expect(events[0]).toMatchObject({
        decision: 'error',
        reason: 'rest_url_configured',
        source: 'none',
      });
    } finally {
      await fga.close();
    }
  });

  it('says so once, not once per read', async () => {
    const env = {
      OPENFGA_API_URL: 'http://openfga:8080',
      OPENFGA_STORE_ID: STORE,
    } as NodeJS.ProcessEnv;

    await grantsForSubject(SUB, T0, env);
    await grantsForSubject('9c1e4d77-2b3a-4f10-9e55-71a0c8d4e6b2', T0, env);

    // A misconfiguration that prints on every read is a misconfiguration that
    // fills a log until the real cause is unfindable — the same one-shot rule
    // the unconfigured warning already follows.
    expect(logged.filter((l) => l.includes('no HTTP path'))).toHaveLength(1);
  });
});
