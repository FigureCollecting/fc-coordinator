// One whole live run of the Phase-2 client against a LOCAL coordinator: the real buildApp on a
// real loopback socket, Postgres (Testcontainers) behind the device table and SyncService, the
// test issuer behind a fake Authentik login, the fake spine behind Compare, and a restart the
// B7 case can ask for. Nothing here reaches beyond 127.0.0.1.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createDeviceStore } from '../../src/auth/plugin.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import type { ClientKey } from '../../scripts/phase2-client/dpop.js';
import { main } from '../../scripts/phase2-client/main.js';
import { createFetchTransport } from '../../scripts/phase2-client/transport.js';
import { makeIssuer, type TestIssuer } from './auth.js';
import { startFakeOidcProvider, signInLikeABrowser, type FakeOidcProvider } from './fakeOidcProvider.js';
import { startFakeSpineRead, type FakeSpineRead } from './fakeSpineRead.js';
import { CLIENT_ID, buildCoordinator, freePort, recording, type Exchanged } from './phase2Harness.js';
import { startSyncDatabase, type SyncDatabase } from './syncDatabase.js';

export const B1_REQUEST = '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}';

export interface FullRun {
  exit: number;
  stdout: string;
  stderr: string;
  log: Exchanged[];
  /** Requests the client's own transport counted. */
  requests: number;
  /** Every value the run handled that must never be printed. */
  secrets: string[];
  userId: string;
  /** The coordinator instances, in order: the second one is the post-restart process. */
  generations: number;
}

export interface RunEnv {
  db: SyncDatabase;
  logLines: string[];
  run(): Promise<FullRun>;
  close(): Promise<void>;
}

export async function startRunEnv(): Promise<RunEnv> {
  const db = await startSyncDatabase();
  const spine: FakeSpineRead = await startFakeSpineRead({ keys: new Map() });
  const userId = randomUUID();
  let issuer: TestIssuer | undefined;
  const provider: FakeOidcProvider = await startFakeOidcProvider({
    clientId: CLIENT_ID,
    mintAccessToken: () => issuer!.mint({ sub: userId }),
  });
  issuer = await makeIssuer({ issuer: provider.issuer, audience: CLIENT_ID });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logLines: string[] = [];
  let generations = 0;
  let app: FastifyInstance | undefined;
  const boot = async (): Promise<void> => {
    app = buildCoordinator({
      issuer: issuer!,
      origin,
      prefix: '/api',
      noncePeriodSeconds: 1,
      devices: createDeviceStore(db.app),
      sync: db.app,
      spineUrl: spine.baseUrl,
      logLines,
    });
    await app.listen({ port, host: '127.0.0.1' });
    generations += 1;
  };
  await boot();

  // The "direct call" B1 compares against: the spine asked without the coordinator in between.
  const direct = await new SpineReadClient(spine.baseUrl, 5_000, []).compare({ gtin14: '04573102591234' }, '2026-09-14T12:00:00.000Z');
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-phase2-'));
  const reference = path.join(dir, 'a7-result.json');
  writeFileSync(reference, direct.resultJson, 'utf8');

  return {
    db,
    logLines,
    async run() {
      const keys: JWK[] = [];
      const jkts: string[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const transport = recording(createFetchTransport(), logLines);
      const exit = await main(
        [
          '--target', origin,
          '--confirm', `127.0.0.1:${port}`,
          '--issuer', provider.issuer,
          '--redirect-uri', 'http://127.0.0.1:0/callback',
          '--b1-request', B1_REQUEST,
          '--b1-reference', reference,
          '--nonce-period-seconds', '1',
        ],
        {
          stdout: { write: (s: string) => stdout.push(s) },
          stderr: { write: (s: string) => stderr.push(s) },
          transport,
          openBrowser: signInLikeABrowser,
          // Extractable HERE only, so the test can grep for the private scalar too.
          generateKey: async (): Promise<ClientKey> => {
            const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
            const publicJwk = await exportJWK(publicKey);
            keys.push(await exportJWK(privateKey));
            const jkt = await calculateJwkThumbprint(publicJwk, 'sha256');
            jkts.push(jkt);
            return { privateKey, publicJwk, jkt, alg: 'ES256' };
          },
          awaitRestart: async () => {
            await app!.close();
            await boot();
          },
          readFile: async (p) => new Uint8Array(await readFile(p)),
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          pollMs: 50,
        },
      );

      const fromRequests = transport.log.flatMap((e) => [e.request.headers['authorization'], e.request.headers['dpop']]);
      const fromResponses = transport.log.map((e) => e.response?.headers.get('dpop-nonce') ?? undefined);
      const secrets = [
        ...provider.secrets(),
        ...fromRequests.map((v) => v?.replace(/^DPoP /, '')),
        ...fromResponses,
        ...keys.flatMap((k) => [k.x, k.y, k.d]),
        ...jkts,
      ].filter((v): v is string => typeof v === 'string' && v.length >= 8);

      return {
        exit,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        log: transport.log,
        requests: transport.count,
        secrets: [...new Set(secrets)],
        userId,
        generations,
      };
    },
    async close() {
      await app?.close();
      await provider.close();
      await spine.close();
      await db.close();
    },
  };
}

/** Every JWT segment of a secret too, so a printed fragment is caught as well as the whole. */
export function leaks(output: string, secrets: string[]): string[] {
  const needles = secrets.flatMap((s) => [s, ...s.split('.').filter((part) => part.length >= 16)]);
  return needles.filter((needle) => output.includes(needle));
}
