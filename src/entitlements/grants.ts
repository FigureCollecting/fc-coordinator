/**
 * entitlementGrants.ts — D6 U6: decide what a caller is entitled to see,
 * BEFORE anything is minted (spec §3(b), §3(d)).
 *
 * ONE QUESTION, ASKED OF OPENFGA: `Check(user:<authentik uuid>,
 * inventory_levels, app:figurecollecting)`. The relation is APP-LEVEL and the
 * object is the app — never a per-object feature join, which is the H-2 leak
 * the B1 model was reshaped to avoid (see fc-infra nodes/fc-ha-01/manifests/
 * b1-model.fga). The model defines the grant as an INTERSECTION with `member`,
 * so a stray direct tuple for a non-member confers nothing; that invariant is
 * the graph's to keep, and this module simply believes the answer.
 *
 * THE RULE THAT MATTERS: ANY CHECK THAT IS NOT AN EXPLICIT `allowed: true` IS
 * A DENY. A 500, a refused connection, a timeout, a body of an unexpected
 * shape, an unconfigured client, a user with no Authentik identity — all of
 * them return no grants. This is the B1 fail-open lesson written down: an
 * authorization model cannot express "an error means no", so the CALLER has to,
 * and the caller is this file. The graph's own suite asserts the positive
 * cases; this suite asserts the negative ones.
 *
 * DENIAL IS NOT AN ERROR ANYWHERE ABOVE THIS LINE. A denied caller gets a
 * normal 200 whose stock magnitudes are simply absent, marked by
 * `coverage.redacted`. Nothing here throws, and nothing here changes a status
 * code: a gate that answers differently when it fails is an existence oracle,
 * and one that 500s is a gate an attacker can knock over to make the system
 * choose between broken and open.
 *
 * WHY A CACHE. This sits on the read hot path, and OpenFGA is a cross-cluster
 * hop (it lives on the auth node, not beside fc-backend). A short per-subject
 * TTL keeps a page of comparisons down to one Check. The cost is propagation
 * delay on a grant or a revoke, bounded by the TTL and already bounded by the
 * assertion's own 60-second lifetime — the same order of magnitude, so the
 * cache does not meaningfully widen the window that already exists.
 *
 * WHY ERRORS GET THEIR OWN, SHORTER TTL. Caching an error-deny for the full
 * window would turn a momentary OpenFGA blip into minutes of silently missing
 * numbers; not caching it at all would point a retry storm at the service that
 * is already unwell. A few seconds is the compromise: the storm is damped, and
 * recovery is quick.
 *
 * IT TAKES A SUBJECT STRING AND NOTHING ELSE. No user model, no database, no
 * notion of how this process authenticates anyone — see the directory note in
 * ./index.ts. Mapping a logged-in user to an Authentik uuid is the host
 * application's job and lives outside this directory, because that mapping is
 * exactly what differs between the backend this runs in today and the
 * Postgres-only one it is destined for.
 */
import axios from 'axios';
import { INVENTORY_LEVELS, type EntitlementName } from '@figurecollecting/ingest-contract/entitlement';
import { mintEntitlementAssertion } from './assertion.js';
import { openFgaAuthHeaders, openFgaAuthMode } from './openfgaToken.js';
import { isEntitlementSubject } from './subject.js';

/** Nothing granted. A frozen shared value so a caller cannot mutate the denial. */
const NO_GRANTS: readonly EntitlementName[] = Object.freeze([]);
const INVENTORY_GRANT: readonly EntitlementName[] = Object.freeze([INVENTORY_LEVELS]);

/** The app object the entitlement hangs off. Overridable so a staging tenant is a config change. */
const DEFAULT_APP_OBJECT = 'app:figurecollecting';
/** Long enough to take the hot path off OpenFGA, short enough that a revoke lands promptly. */
const DEFAULT_CACHE_TTL_MS = 30_000;
/** A failed Check is remembered only briefly — see the header note. */
const DEFAULT_ERROR_TTL_MS = 5_000;
/** Tight by intent: this is a blocking hop inside a user-facing read. */
const DEFAULT_TIMEOUT_MS = 2_000;
/**
 * Hard ceiling on cached subjects. The cache is keyed by subject and nothing
 * ever removed an entry, so it grew with every distinct identity the process
 * had ever seen and never shrank. That is bounded by the user count in the
 * application this runs in today, and unbounded in one that takes the subject
 * straight from a session claim — which is exactly where this module is going.
 */
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUDIT SEAM.
 *
 * OpenFGA logs no authenticated subject — a Check entry names the store, the
 * method and a request id, and nothing that says WHO asked — and the
 * multicluster gateway collapses every caller into one mesh identity before the
 * request arrives. So the decision is per-caller and the record is not, and the
 * only place the distinction can be written down is here, at the caller.
 *
 * COUNTERS ARE NOT AN AUDIT TRAIL. "seventeen denies" answers no question worth
 * asking after the fact.
 *
 * THE SUBJECT GOES IN THE LINE, AND IT DOES NOT GO ON A SPAN. Those are not in
 * conflict, they are about different sinks: the estate's telemetry rule keeps
 * `sub` off spans, where it would fan out to a collector and a trace store,
 * while this line stays in the application log behind the same boundary as the
 * process. The subject is a pseudonymous provider uuid, and without it the
 * record answers nothing. Do not "fix" this by dropping it, and do not "fix"
 * the span rule by adding it.
 *
 * WHY A SINK VARIABLE RATHER THAN AN IMPORT. This directory is a portable copy
 * — test/entitlements/portability.test.ts fails the build if it reaches outside
 * itself for anything but axios and the contract — so it cannot import the host
 * application's logger. The host installs one; unset falls back to the console,
 * because a module that silently drops its audit trail when copied into a new
 * host is worse than one that never had it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** What the Check concluded. `error` is a sick dependency; `deny` is a revoked user. */
export type EntitlementDecision = 'allow' | 'deny' | 'error' | 'unconfigured' | 'bad_subject';

/** Where the answer came from. A cache hit is still a decision. */
export type EntitlementAuditSource = 'openfga' | 'cache' | 'coalesced' | 'none';

export interface EntitlementAuditEvent {
  event: 'entitlement.check';
  /** The provider uuid the question was asked about. Never on a span. */
  subject: string;
  relation: string;
  object: string;
  decision: EntitlementDecision;
  source: EntitlementAuditSource;
  /** Measured around the HTTP call. Zero when there was not one. */
  latency_ms: number;
  /** The pinned model, when one is pinned — the answer is only reproducible against it. */
  model_id?: string;
  /** Present when OpenFGA answered, so a 504 is distinguishable from a 401. */
  http_status?: number;
  /** Why, when the status does not say: `transport`, `bad_body`, `token_mint_failed`. */
  reason?: string;
}

export type EntitlementAuditSink = (event: EntitlementAuditEvent) => void;

/**
 * Stands in for a subject that failed the uuid rule. That value came from the
 * host and can be anything it had to hand — an email, a session id, a username
 * — so the DECISION belongs in the record and the value does not.
 */
const REDACTED_SUBJECT = '(invalid)';

let auditSink: EntitlementAuditSink | null = null;

/** Install the host's logger. Pass null to go back to the console. */
export const setEntitlementAuditSink = (sink: EntitlementAuditSink | null): void => {
  auditSink = sink;
};

function emitAudit(event: EntitlementAuditEvent): void {
  try {
    if (auditSink !== null) auditSink(event);
    else console.info('[ENTITLEMENT]', JSON.stringify(event));
  } catch {
    // An audit line is a RECORD, not a gate. A host whose logger throws must
    // not turn every entitled read into a denial; that would be a fail-closed
    // rule applied to the one thing it should never govern.
  }
}

/** The answer, plus everything the record needs to say about how it was reached. */
interface Decision {
  grants: readonly EntitlementName[];
  decision: EntitlementDecision;
  httpStatus?: number;
  reason?: string;
}

interface CacheEntry extends Decision {
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Decision>>();
const counters = new Map<string, number>();
let warnedUnconfigured = false;

const bump = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

/** Snapshot: `allow`, `deny`, `error`, `unconfigured`, `bad_subject`, `cache_hit`, `coalesced`, `evicted`, `reminted`. */
export const entitlementGrantCounters = (): Readonly<Record<string, number>> => Object.fromEntries(counters);

/**
 * Test seam: drop the cache, the in-flight map, the counters and the one-shot
 * warning. The audit sink is NOT cleared — it is host wiring installed once at
 * boot, not per-request state, and clearing it here would silently unwire the
 * one thing a test might be asserting on.
 */
export const resetEntitlementGrantsForTest = (): void => {
  cache.clear();
  inflight.clear();
  counters.clear();
  warnedUnconfigured = false;
};

/**
 * A positive finite number from the environment, or the default.
 *
 * STRICTLY GREATER THAN ZERO. Every value read through this is a BOUND — a
 * timeout, a cache lifetime, a map size — and zero is not a smaller bound, it
 * is the absence of one. axios in particular reads `timeout: 0` as "wait
 * forever", so a single typo in a deployment would turn the Check on a
 * user-facing read path into an unbounded hang. A nonsensical value falls back
 * to the documented default rather than being honoured.
 */
const num = (raw: string | undefined, fallback: number): number => {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** What one Check came back as. `errored` separates a sick dependency from a revoked user. */
interface CheckOutcome {
  allowed: boolean;
  errored: boolean;
  /** Present when OpenFGA answered at all, so a 504 is distinguishable from a 401. */
  httpStatus?: number;
  /** Why, when the reason is not simply the status. */
  reason?: string;
}

/**
 * Ask OpenFGA. Resolves to `true` ONLY on an explicit `allowed: true`;
 * everything else resolves to `false` and is counted as an error rather than a
 * deny, so an operator can tell a revoked user apart from a sick dependency.
 *
 * NO `validateStatus`, AND THAT IS LOAD-BEARING. axios's default rejects on any
 * non-2xx, which is what turns a proxy's fast 504 during a partition into an
 * error-deny here. A partition does NOT surface as a transport exception — the
 * sidecar answers — so fail-closed logic keying on a thrown connection error
 * would sail straight past it. Setting `validateStatus` at all would move every
 * non-2xx into the success branch, where the body has no boolean `allowed` and
 * the outcome happens to stay a deny for the wrong reason. Pinned by
 * test/entitlements/fail-closed.test.ts, both behaviourally and as source.
 *
 * ONE RETRY, ONLY ON 401, ONLY ON THE OIDC PATH. A cached token that expired or
 * was rotated under us is the one failure a retry can fix, and it is bounded at
 * one: re-mint, ask again, and if the answer is still 401 then the credential
 * is wrong rather than stale, and looping would turn that into a request storm
 * against the identity provider.
 */
async function check(subject: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<CheckOutcome> {
  const apiUrl = env.OPENFGA_API_URL?.trim();
  const storeId = env.OPENFGA_STORE_ID?.trim();
  if (!apiUrl || !storeId) {
    bump('unconfigured');
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        '[ENTITLEMENT] OpenFGA is not configured (OPENFGA_API_URL / OPENFGA_STORE_ID) — every entitlement check denies and spine reads come back redacted. Expected until the authz substrate is wired.'
      );
    }
    return { allowed: false, errored: false, reason: 'unconfigured' };
  }

  const body: Record<string, unknown> = {
    tuple_key: {
      user: `user:${subject}`,
      relation: INVENTORY_LEVELS,
      object: env.OPENFGA_APP_OBJECT?.trim() || DEFAULT_APP_OBJECT,
    },
  };
  // Pinning the model id makes the answer reproducible across a model rollout;
  // without it OpenFGA evaluates against whatever the latest model is.
  const modelId = env.OPENFGA_MODEL_ID?.trim();
  if (modelId) body.authorization_model_id = modelId;

  const url = `${apiUrl.replace(/\/+$/, '')}/stores/${storeId}/check`;
  const timeout = num(env.OPENFGA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const canRemint = openFgaAuthMode(env) === 'oidc';
  let reminted = false;

  for (;;) {
    const auth = await openFgaAuthHeaders(env, nowMs, { forceRefresh: reminted });
    if (auth === undefined) {
      // A credential IS configured and could not be obtained. Never fall
      // through to an unauthenticated Check: OpenFGA would answer 401 and the
      // outcome would be identical, but the record would name the wrong cause.
      return { allowed: false, errored: true, reason: 'token_mint_failed' };
    }

    try {
      const response = await axios.post(url, body, {
        timeout,
        // A 3xx IS THE ONE NON-2xx THE RULE ABOVE DOES NOT COVER, because it
        // never reaches it: axios follows the redirect and the answer arrives
        // as a 200 from somewhere else entirely. So the fail-closed rule held
        // for every status class that had been asked about and failed OPEN for
        // the one that had not. A redirect target answering `{"allowed": true}`
        // could issue the grant, unauthenticated — the bearer is dropped on a
        // cross-host hop, so what leaks is not a credential but the DECISION.
        //
        // With this at 0 the 3xx comes back as an ordinary response and the
        // default validateStatus rejects it, so it denies like any other
        // non-2xx. Pinned in test/entitlements/redirect.test.ts across 301,
        // 302, 303, 307 and 308, each with a body claiming a grant.
        maxRedirects: 0,
        headers: { 'content-type': 'application/json', ...auth },
      });
      const data: unknown = response.data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        // A 200 carrying something that is not a Check response is a wire-level
        // surprise, not a decision. Treated as a fault so it shows up as one.
        console.error('[ENTITLEMENT] OpenFGA Check returned an unexpected body shape — denying');
        return { allowed: false, errored: true, httpStatus: response.status, reason: 'bad_body' };
      }
      const allowed = (data as { allowed?: unknown }).allowed;
      if (typeof allowed !== 'boolean') {
        console.error('[ENTITLEMENT] OpenFGA Check response has no boolean `allowed` — denying');
        return { allowed: false, errored: true, httpStatus: response.status, reason: 'bad_body' };
      }
      return { allowed, errored: false, httpStatus: response.status };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 401 && canRemint && !reminted) {
        reminted = true;
        bump('reminted');
        continue;
      }
      // The message ONLY. An axios error carries the full request config,
      // headers included, so anything broader than this prints the credential.
      console.error('[ENTITLEMENT] OpenFGA Check failed — denying:', (err as Error).message);
      return {
        allowed: false,
        errored: true,
        ...(status === undefined ? {} : { httpStatus: status }),
        reason: status === undefined ? 'transport' : 'http_error',
      };
    }
  }
}

/**
 * Write one entry, keeping the map bounded.
 *
 * Expired entries go first — they are dead weight and evicting them costs
 * nothing — and only if that is not enough does it drop the least recently
 * written, which a Map gives us for free because it preserves insertion order
 * and every write re-inserts. Evicting a LIVE entry is not a correctness
 * problem: the next lookup for that subject simply asks OpenFGA again. An
 * unbounded map, by contrast, is a slow leak in a long-lived process.
 */
function cacheSet(subject: string, entry: CacheEntry, nowMs: number, env: NodeJS.ProcessEnv): void {
  const max = num(env.ENTITLEMENT_GRANT_CACHE_MAX, DEFAULT_CACHE_MAX_ENTRIES);
  if (cache.size >= max) {
    for (const [key, value] of cache) {
      if (value.expiresAt <= nowMs) {
        cache.delete(key);
        bump('evicted');
      }
    }
    // Oldest first, stopping the moment there is room. Written as a loop over
    // the keys rather than repeated `next()` calls so there is no unreachable
    // "the map was empty" guard: the iteration ends on its own, and both exits
    // are paths a test can take.
    for (const key of cache.keys()) {
      if (cache.size < max) break;
      cache.delete(key);
      bump('evicted');
    }
  }
  // Re-insert so insertion order tracks write recency rather than first sight.
  cache.delete(subject);
  cache.set(subject, entry);
}

/**
 * What this subject may see. `nowMs` is injected so cache expiry is testable
 * without sleeping.
 */
export async function grantsForSubject(
  subject: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly EntitlementName[]> {
  const relation = INVENTORY_LEVELS;
  const object = env.OPENFGA_APP_OBJECT?.trim() || DEFAULT_APP_OBJECT;
  const modelId = env.OPENFGA_MODEL_ID?.trim();

  /** One line per decision, whichever of the four paths reached it. */
  const audit = (
    who: string,
    decision: Decision,
    source: EntitlementAuditSource,
    latencyMs: number,
  ): void => {
    emitAudit({
      event: 'entitlement.check',
      subject: who,
      relation,
      object,
      decision: decision.decision,
      source,
      latency_ms: latencyMs,
      ...(modelId ? { model_id: modelId } : {}),
      ...(decision.httpStatus === undefined ? {} : { http_status: decision.httpStatus }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    });
  };

  // The subject shape is enforced HERE, before anything is asked of OpenFGA.
  // A differently-shaped identifier is not a question OpenFGA can answer wrong
  // — it is a question no tuple can ever match, so the answer is a permanent,
  // silent `false`. See ./subject.ts.
  if (!isEntitlementSubject(subject)) {
    bump('bad_subject');
    audit(REDACTED_SUBJECT, { grants: NO_GRANTS, decision: 'bad_subject' }, 'none', 0);
    return NO_GRANTS;
  }

  const hit = cache.get(subject);
  if (hit !== undefined && nowMs < hit.expiresAt) {
    bump('cache_hit');
    // The ORIGINAL decision, replayed. A cached error-deny reported as a plain
    // deny reads like a revocation that never happened.
    audit(subject, hit, 'cache', 0);
    return hit.grants;
  }

  // One Check per subject in flight. Without this, a cold cache under load
  // sends OpenFGA one request per concurrent read for the SAME answer.
  const pending = inflight.get(subject);
  if (pending !== undefined) {
    bump('coalesced');
    const shared = await pending;
    audit(subject, shared, 'coalesced', 0);
    return shared.grants;
  }

  const run = (async (): Promise<Decision> => {
    // Wall clock, not the injected `nowMs`: this measures how long the hop took,
    // and `nowMs` is a fixed instant the caller chose for cache arithmetic.
    const startedAt = Date.now();
    const outcome = await check(subject, env, nowMs);
    const latencyMs = Date.now() - startedAt;

    const grants = outcome.allowed ? INVENTORY_GRANT : NO_GRANTS;
    // The counters keep their long-standing behaviour: an unconfigured client
    // is counted by check() AND bumps `deny` here, exactly as before, so
    // nothing that reads these numbers today changes. The AUDIT line is where
    // the distinction is drawn, because that is the thing being added.
    bump(outcome.errored ? 'error' : outcome.allowed ? 'allow' : 'deny');
    const name: EntitlementDecision =
      outcome.reason === 'unconfigured'
        ? 'unconfigured'
        : outcome.errored
          ? 'error'
          : outcome.allowed
            ? 'allow'
            : 'deny';

    const decision: Decision = {
      grants,
      decision: name,
      ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
      ...(outcome.reason === undefined || outcome.reason === 'unconfigured'
        ? {}
        : { reason: outcome.reason }),
    };

    const ttl = outcome.errored
      ? num(env.ENTITLEMENT_GRANT_ERROR_TTL_MS, DEFAULT_ERROR_TTL_MS)
      : num(env.ENTITLEMENT_GRANT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
    cacheSet(subject, { ...decision, expiresAt: nowMs + ttl }, nowMs, env);

    // `source` NAMES WHERE THE ANSWER CAME FROM, and two decisions reach here
    // having made no request at all: an unconfigured client, which returns
    // before a request is even built, and a failed token mint, which refuses to
    // ask unauthenticated. Reporting either as `openfga` says the service
    // answered when it was never asked — and this is the one field separating a
    // refusal by OpenFGA and a question that never got there, so anyone
    // counting OpenFGA traffic by it would over-count by exactly the outage
    // they are diagnosing. `bad_subject` already gets this right above.
    //
    // NOTE TO A FUTURE EDITOR: do not write the word `from` immediately before
    // a quoted string anywhere in this directory, comments included. The
    // portability guard's specifier extractor does not strip comments — on
    // purpose, since a partial guard is worse than none — so it reads that
    // shape as an import and fails the build. This comment cost one.
    const asked = name !== 'unconfigured' && outcome.reason !== 'token_mint_failed';
    audit(subject, decision, asked ? 'openfga' : 'none', asked ? latencyMs : 0);
    return decision;
  })();

  inflight.set(subject, run);
  try {
    return (await run).grants;
  } finally {
    inflight.delete(subject);
  }
}

/**
 * The `fc-entitlements` header value for this subject, or `null` when there is
 * nothing to send.
 *
 * THE WHOLE MODULE IN ONE CALL, and the only entry point a host application
 * needs: check, then sign the outcome. Both halves already resolve every
 * failure to "nothing", so this does too — and a caller that gets `null`
 * attaches no header, which is what a denial looks like on the wire.
 */
export async function entitlementHeaderFor(
  subject: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const ent = await grantsForSubject(subject, nowMs, env);
  return mintEntitlementAssertion({ sub: subject, ent }, nowMs, env);
}
