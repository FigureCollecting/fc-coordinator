// WK-11 ACCEPTANCE (a) and (c): one live run of the Phase-2 client against a LOCAL coordinator
// with the test issuer, over real loopback sockets, with Postgres behind the device table. All
// nine proof-level cases give their expected outcome, and the run's stdout and stderr carry no
// token, code, verifier, proof, nonce or JWK material.
//
// This coordinator is on fc-api-contract 0.3.0 (WK-05b), so the sync smoke's occ/{occ}/head and
// occ/{occ}/status are APPLIED and the whole run passes. The smoke's failure paths, the refusal a
// coordinator that predates 0.3.0 gives included, are in live-local-030.test.ts.
import { fromBinary } from '@bufbuild/protobuf';
import { PushRequestSchema } from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isOccSmokeKey } from '../../scripts/phase2-client/occ030.js';
import { reasonsFor } from '../helpers/phase2Harness.js';
import { leaks, startRunEnv, type FullRun, type RunEnv } from '../helpers/phase2Run.js';

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

describe('acceptance (a): the nine cases against a local coordinator with the test issuer', () => {
  it('reports PASS for each of B1, B2, B3, B4, B5b, B6, B7, B8 and B9b', () => {
    for (const id of ['B1', 'B2', 'B3', 'B4', 'B5b', 'B6', 'B7', 'B8', 'B9b']) {
      expect(line(id), id).toMatch(new RegExp(`^${id} +PASS `));
    }
  });

  it('B1: 200 with result_json byte-identical to a direct call', () => {
    expect(line('B1')).toMatch(/200; result_json \d+ bytes sha256 [0-9a-f]{64}, byte-identical to the reference/);
  });

  it('B2 and B3: rejected, for the reason each case names', () => {
    expect(reasonsFor(run.log, 'B2')).toEqual(['missing_proof']);
    expect(reasonsFor(run.log, 'B3:replay')).toEqual(['jti_replayed']);
  });

  it('B4: key_not_bound', () => {
    expect(reasonsFor(run.log, 'B4:stray')).toEqual(['key_not_bound']);
  });

  it('B5b: succeeds on the retry', () => {
    expect(reasonsFor(run.log, 'B5b:no-nonce')).toEqual(['nonce_missing']);
    expect(run.log.find((e) => e.request.label === 'B5b:retry')!.response!.status).toBe(200);
  });

  it('B6: the previous-bucket nonce is accepted', () => {
    const b6 = run.log.filter((e) => e.request.label === 'B6');
    expect(b6.at(-1)!.response!.status).toBe(200);
  });

  it('B7: rejected on the nonce check, with the replay cache empty', () => {
    expect(run.generations).toBe(2);
    const polls = run.log.filter((e) => e.request.label === 'B7:poll');
    expect(polls.at(-1)!.reasons).toEqual(['nonce_invalid']);
    const replayed = run.log.find((e) => e.request.label === 'B7:replayed-jti')!;
    expect(replayed.response!.status).toBe(200);
    expect(replayed.reasons).toEqual([]);
  });

  it('B8: the revoked device is rejected while a second device keeps working', () => {
    expect(reasonsFor(run.log, 'B8:second-after')).toEqual(['key_not_bound']);
    expect(run.log.find((e) => e.request.label === 'B8:primary-after')!.response!.status).toBe(200);
  });

  it('B9b: htu_mismatch', () => {
    expect(reasonsFor(run.log, 'B9b:www')).toEqual(['htu_mismatch']);
  });
});

describe('the sync smoke on a coordinator on contract 0.3.0', () => {
  it('pushes only occ/{occ}/head and occ/{occ}/status, never holding/*', () => {
    const pushes = run.log.filter((e) => e.request.label.startsWith('smoke:push'));
    expect(pushes.length).toBeGreaterThan(0);
    const keys = pushes.flatMap((e) => fromBinary(PushRequestSchema, e.request.body as Uint8Array).events.map((ev) => ev.facetKey));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(isOccSmokeKey(key), key).toBe(true);
      expect(key.startsWith('holding/')).toBe(false);
    }
    expect(new Set(keys.map((k) => k.split('/').at(-1)))).toEqual(new Set(['head', 'status']));
  });

  it('passes after a Status that answered: both keys APPLIED, and Delta shows both', () => {
    expect(run.log.find((e) => e.request.label === 'smoke:status')!.response!.status).toBe(200);
    expect(line('smoke')).toMatch(/^smoke +PASS Status, then one Push \(occ\/[0-9a-f-]{36}\/head, occ\/[0-9a-f-]{36}\/status: APPLIED\)/);
  });

  it('exits 0, and says how many cases passed', () => {
    expect(run.exit).toBe(0);
    expect(run.stdout).toMatch(/9 of 9 cases PASS; the sync smoke PASS/);
  });
});

describe('acceptance (c): stdout and stderr carry no token or JWK material', () => {
  it('collected a real set of secrets to look for', () => {
    // Anti-vacuous: the access, id and refresh tokens, the code and verifier, every proof and
    // nonce, three keys' x/y/d and thumbprints.
    expect(run.secrets.length).toBeGreaterThan(40);
  });

  it('finds none of them in either stream, whole or as a JWT segment', () => {
    expect(leaks(run.stdout, run.secrets)).toEqual([]);
    expect(leaks(run.stderr, run.secrets)).toEqual([]);
  });

  it('never needed the scrubber: nothing was redacted, so nothing tried to print a secret', () => {
    expect(run.stdout).not.toContain('[redacted]');
    expect(run.stderr).not.toContain('[redacted]');
  });
});

describe('what the run leaves behind', () => {
  it('revokes both of its devices: B8 the second, the cleanup the primary', async () => {
    const { rows } = await env.db.admin.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM device WHERE user_id = $1',
      [run.userId],
    );
    expect(rows.map((r) => r.revoked)).toEqual([true, true]);
    expect(line('cleanup')).toMatch(/^cleanup +PASS /);
  });

  it('sent every request through its one counted transport', () => {
    expect(run.requests).toBe(run.log.length);
    expect(run.stdout).toContain(`requests sent: ${run.requests}`);
  });
});
