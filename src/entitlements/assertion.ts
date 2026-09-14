/**
 * entitlementAssertion.ts — D6 U6: MINT the `fc-entitlements` assertion
 * fc-backend attaches to its SpineRead calls (spec §3(b)).
 *
 * WHAT THIS IS. The spine's read projection redacts stock MAGNITUDES unless the
 * caller proves an entitlement. fc-backend is the only user-facing caller
 * (lookup-caller-architecture, RATIFIED), so it is the only party that knows
 * WHO is asking; it runs its own OpenFGA Check (see entitlementGrants.ts) and
 * then signs a 60-second statement of the outcome. The spine verifies that
 * signature and never learns a user identity by any other route.
 *
 * WHAT IT DOES NOT DO. It does not decide anything. `ent` is handed to it by
 * the Check; this module will sign whatever it is given, which is exactly why
 * the caller's fail-closed mapping (Check error -> deny) is the load-bearing
 * half and lives next door with its own tests.
 *
 * THE FAILURE MODE IS SILENCE, BY DESIGN. No key, an unreadable key, the wrong
 * key type, no kid, a subject of the wrong shape, nothing granted -> `null`,
 * and the caller sends NO header. At the spine that is indistinguishable from
 * every other rejection: a normal 200 with the levels withheld and
 * `coverage.redacted` set. So a misconfigured deploy degrades to "nobody sees
 * magnitudes", never to an outage and never to an open gate.
 *
 * IT NEVER THROWS, AND THAT IS LITERAL. Both inputs are validated at runtime
 * rather than trusted to a type annotation: this module is published as a
 * portable unit and will be called from code TypeScript has not checked, where
 * a `null` grant list or a non-string subject is a `TypeError` out of a
 * security path. A read that would have succeeded redacted must not become a
 * 500 because a Secret was not mounted or a caller passed the wrong thing.
 *
 * KEY DELIVERY (mirror image of the spine's, deliberately):
 *   ENTITLEMENT_SIGNING_KEY_PEM   the PKCS#8 PEM itself (a mounted Secret's
 *                                 value, or an env var in a plain deploy)
 *   ENTITLEMENT_SIGNING_KEY_FILE  a path to that PEM (a projected Secret file)
 *   ENTITLEMENT_SIGNING_KID       the key id that goes in the JOSE header
 *   ENTITLEMENT_SIGNING_ISSUER    the `iss` claim; defaults to the contract's
 *                                 ENTITLEMENT_ISSUER
 * With a FILE and no explicit kid, the kid is the file's basename minus its
 * extension — the same `<kid>.pub` convention the spine uses to name its
 * verification keys, so a rotation that drops `ent-2027-03.key` beside a
 * matching `ent-2027-03.pub` needs no second variable to be changed in step.
 * With an inline PEM there is no filename to read, so the kid is required.
 *
 * THE ISSUER IS CONFIGURATION, AND THAT IS A TRAP WORTH NAMING. The spine's
 * verifier PINS `iss` to a single expected value and rejects anything else the
 * way it rejects everything else: SILENTLY, with empty grants and a normal 200.
 * So an issuer the verifier does not expect is indistinguishable, from the
 * outside, from a user who simply has no grant — no error, no log at the spine,
 * just numbers that never appear.
 *
 * The default is therefore the contract's own ENTITLEMENT_ISSUER, which is what
 * the deployed verifier expects today, and changing it is a TWO-SIDED DEPLOY:
 * the verifier must be taught the new issuer FIRST, or every read goes redacted
 * the moment this variable is set. Setting it to anything else logs one warning
 * saying exactly that. It exists so the coordinator can eventually stop
 * claiming to be the service it replaced, not so it can be changed casually.
 *
 * THE KEY IS READ ONCE. A signing key is not a feature flag: re-reading it per
 * request would put a filesystem call on the hot read path and make the
 * process's identity depend on when a request happened to arrive. Rotation is
 * a restart (or the test seam below), which is also what mounting a new Secret
 * does.
 *
 * NOTHING HERE IS EVER LOGGED. Not the key, not the token, not the subject.
 * The token is a bearer grant for its 60 seconds, and a log line carrying one
 * hands that grant to everyone who can read logs. The only output is the one
 * startup line saying whether minting is on.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isEntitlementSubject } from './subject.js';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TTL_SECONDS,
  type EntitlementAssertion,
  type EntitlementName,
} from '@figurecollecting/ingest-contract/entitlement';

export interface MintRequest {
  /** The Authentik user uuid the Check was run for. */
  sub: string;
  /** What that Check said they hold. Empty means there is nothing to assert. */
  ent: readonly EntitlementName[];
}

interface SigningKey {
  key: crypto.KeyObject;
  kid: string;
  /** The `iss` claim this process mints under. See the header note. */
  issuer: string;
}

/**
 * The claim set as MINTED.
 *
 * The contract types `iss` as the literal `typeof ENTITLEMENT_ISSUER`, because
 * it was written for a world with exactly one mint. Widening it HERE, and only
 * here, is the honest way to say that the issuer became configuration while
 * every other claim stays pinned to the contract — a cast at the assignment
 * would have hidden the same fact. When the spine's verifier learns to accept a
 * LIST of issuers, the contract can widen and this alias disappears.
 */
type MintedAssertion = Omit<EntitlementAssertion, 'iss'> & { iss: string };

/** `null` = minting is off (no key, or a key this process refuses to use). */
type KeyState = SigningKey | null;

let keyState: KeyState | undefined;

const counters = new Map<string, number>();
const bump = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

/** Snapshot of the mint counters: `minted`, `disabled`, `no_grants`, `bad_subject`. */
export const entitlementMintCounters = (): Readonly<Record<string, number>> => Object.fromEntries(counters);

/** Test seam: forget the loaded key and the counters so the next call re-reads env. */
export const resetEntitlementSigningForTest = (): void => {
  keyState = undefined;
  counters.clear();
};

/**
 * Read the key from env, ONCE. Every refusal is reported as one warning naming
 * the consequence, because "reads come back redacted" is the symptom an
 * operator will actually be chasing, and the variable name alone does not
 * connect the two.
 */
function loadSigningKey(env: NodeJS.ProcessEnv): KeyState {
  const inlinePem = env.ENTITLEMENT_SIGNING_KEY_PEM?.trim();
  const keyFile = env.ENTITLEMENT_SIGNING_KEY_FILE?.trim();

  if (!inlinePem && !keyFile) {
    console.warn(
      '[ENTITLEMENT] no signing key configured (ENTITLEMENT_SIGNING_KEY_PEM / ENTITLEMENT_SIGNING_KEY_FILE) — no assertion will be sent and EVERY spine read comes back redacted. Expected until the signing Secret is mounted.'
    );
    return null;
  }

  let pem: string;
  if (inlinePem) {
    pem = inlinePem;
  } else {
    try {
      pem = fs.readFileSync(keyFile as string, 'utf8');
    } catch {
      // The path, not the contents: a path is configuration, and this is the
      // one message that tells an operator which mount did not arrive.
      console.warn(
        `[ENTITLEMENT] signing key file is unreadable (${keyFile}) — minting disabled, every spine read comes back redacted.`
      );
      return null;
    }
  }

  // Explicit kid wins; otherwise derive it from the filename, mirroring the
  // spine's `<kid>.pub`. An inline PEM has no name to derive from.
  let kid = env.ENTITLEMENT_SIGNING_KID?.trim() ?? '';
  if (kid === '' && keyFile) {
    kid = path.basename(keyFile, path.extname(keyFile));
  }
  if (kid === '') {
    console.warn(
      '[ENTITLEMENT] a signing key is configured but ENTITLEMENT_SIGNING_KID is not, and an inline PEM has no filename to derive it from — minting disabled, every spine read comes back redacted.'
    );
    return null;
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    // Never echo the material, not even a prefix of it.
    console.warn('[ENTITLEMENT] signing key is not a readable private key PEM — minting disabled, every spine read comes back redacted.');
    return null;
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    // Pin the algorithm AT THE KEY. The spine pins `alg` in the JOSE header to
    // EdDSA and its keys to Ed25519, so anything else here mints tokens that
    // are refused on arrival — better to refuse at the source and say why.
    console.warn(
      `[ENTITLEMENT] signing key is ${String(key.asymmetricKeyType)}, expected ed25519 — minting disabled, every spine read comes back redacted.`
    );
    return null;
  }
  // The issuer the verifier is expected to accept. Read ONCE alongside the key,
  // for the same reason: a process's claimed identity must not depend on when a
  // request happened to arrive.
  const configuredIssuer = env.ENTITLEMENT_SIGNING_ISSUER?.trim() ?? '';
  const issuer = configuredIssuer === '' ? ENTITLEMENT_ISSUER : configuredIssuer;
  if (issuer !== ENTITLEMENT_ISSUER) {
    // Not a refusal — an operator may be mid-way through the two-sided deploy,
    // and refusing would make the SAFE ordering (teach the verifier, then
    // switch the mint) impossible. But it is the one line that connects a
    // deliberate config change to the symptom it causes if the other side is
    // not ready, so it names both.
    console.warn(
      `[ENTITLEMENT] minting under issuer "${issuer}" instead of the contract default "${ENTITLEMENT_ISSUER}" — the spine verifier PINS this claim and rejects a mismatch SILENTLY, so unless ingest-server has already been configured to accept it, every spine read comes back redacted with no error anywhere.`
    );
  }

  return { key, kid, issuer };
}

function signingKey(env: NodeJS.ProcessEnv = process.env): KeyState {
  if (keyState === undefined) keyState = loadSigningKey(env);
  return keyState;
}

/**
 * Load the key eagerly and say so, once, at boot. Call it from the server
 * bootstrap so a missing Secret is visible at start rather than discovered by a
 * user whose numbers quietly vanished. Returns whether minting is enabled.
 */
export function initEntitlementSigning(env: NodeJS.ProcessEnv = process.env): boolean {
  const state = signingKey(env);
  if (state === null) return false;
  console.log(
    `[ENTITLEMENT] assertion minting enabled (kid=${state.kid}, alg=${ENTITLEMENT_ALG}, iss=${state.issuer})`
  );
  return true;
}

const b64url = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * Mint one compact JWS, or `null` when there is nothing to mint.
 *
 * `nowMs` is injected rather than read here so the claim set is a pure function
 * of its inputs — the same discipline read.proto's FIDELITY DOCTRINE applies to
 * the RPC, and the only way a test can assert `exp - iat` without racing a
 * second boundary.
 */
export function mintEntitlementAssertion(
  { sub, ent }: MintRequest,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const state = signingKey(env);
  if (state === null) {
    bump('disabled');
    return null;
  }
  // An assertion granting nothing is a header the spine parses, verifies and
  // then ignores: pure cost, and one more place a bearer token exists. The
  // Array check is not ceremony — an untyped caller passing null or a bare
  // string would otherwise throw out of a security path.
  if (!Array.isArray(ent) || ent.length === 0) {
    bump('no_grants');
    return null;
  }
  // The subject must be an Authentik uuid (./subject.ts). Guarded HERE as well
  // as in the Check because the mint is an exported entry point in its own
  // right, and because this is the module's only statement about identity once
  // the host application's own user model is out of the picture. The uuid shape
  // also bounds the subject at 36 characters, so an accepted one can never mint
  // a header near the verifier's 4096-byte ceiling.
  if (!isEntitlementSubject(sub)) {
    bump('bad_subject');
    return null;
  }

  const iat = Math.floor(nowMs / 1000);
  const header = { alg: ENTITLEMENT_ALG, typ: 'JWT', kid: state.kid };
  // `kid` appears in the payload as well as the JOSE header: the contract's
  // EntitlementAssertion declares it, and the spine reads it from the header.
  // Both copies are inside the signature, so they cannot disagree undetected.
  const payload: MintedAssertion = {
    // Configuration, not a constant — see the header note. The spine PINS this
    // and rejects a mismatch silently, so the default is the contract's value.
    iss: state.issuer,
    aud: ENTITLEMENT_AUDIENCE,
    sub,
    ent,
    iat,
    exp: iat + ENTITLEMENT_TTL_SECONDS,
    kid: state.kid,
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  let signature: Buffer;
  try {
    // Ed25519 signs the message directly: the algorithm argument is `null`, not
    // a digest name. Passing one throws, which is why this is guarded at all.
    signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), state.key);
  } catch {
    console.warn('[ENTITLEMENT] signing failed — sending no assertion; the read will come back redacted.');
    bump('disabled');
    return null;
  }
  bump('minted');
  return `${signingInput}.${signature.toString('base64url')}`;
}
