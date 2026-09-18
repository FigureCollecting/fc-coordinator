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
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport, Http2SessionManager } from '@connectrpc/connect-node';
import { INVENTORY_LEVELS, type EntitlementName } from '@figurecollecting/ingest-contract/entitlement';
import { mintEntitlementAssertion } from './assertion.js';
import { OpenFGAService } from './gen/openfga/v1/openfga_service_pb.js';
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
/** The one scheme this Check presents, and the prefix a refusal has to strip back off. */
const BEARER = 'Bearer ';
/**
 * What an operator is told when the retired variable is still set. Named once
 * so the boot refusal and the per-call refusal cannot drift into saying
 * different things about the same misconfiguration.
 */
const REST_URL_REFUSAL =
  'OPENFGA_API_URL is set and this build has no HTTP path. The Check is gRPC on :8081; rename the variable to OPENFGA_GRPC_URL and point it at the gRPC port (for example http://openfga-mc-fc-ha.authz.svc.cluster.local:8081). Refusing to start rather than silently denying every read.';
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
 * itself for anything but its declared set — so it cannot import the host
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
  /** Measured around the gRPC call. Zero when there was not one. */
  latency_ms: number;
  /** The pinned model, when one is pinned — the answer is only reproducible against it. */
  model_id?: string;
  /**
   * The gRPC status the call ended on, lower-underscore as gRPC names them:
   * `ok`, `unauthenticated`, `permission_denied`, `unavailable`,
   * `deadline_exceeded`, `internal`. Present whenever the call was ATTEMPTED,
   * which is what the old `http_status` meant, and absent on the two decisions
   * that never reach the wire (`unconfigured`, `token_mint_failed`).
   *
   * IT REPLACES `http_status` OUTRIGHT — not alongside it, and never as null.
   * A consumer reading `http_status` should stop finding the key rather than
   * find it empty, because a key that is present and meaningless is how a
   * dashboard keeps reporting after the thing it measured stopped existing.
   * The C21 acceptance table in plan §6.4 is written in HTTP statuses and has
   * to be rewritten against these names; that is R2's change, listed in this
   * unit's report.
   *
   * ONE DISTINCTION IS GENUINELY LOST, and it is better said than hidden: over
   * HTTP a refused connection had no status and a served error had one, so
   * `transport` and `http_error` could be told apart. gRPC gives a connection
   * failure and a server that answers "I am unavailable" the SAME code,
   * `unavailable`, and no part of the protocol distinguishes them. Guessing
   * from the error's shape would be a private detail of the client library
   * dressed as a fact, so the record says `unavailable` and means it.
   */
  grpc_code?: string;
  /**
   * OpenFGA's OWN error number, present only when it sent one outside the
   * canonical gRPC range — 1010 `bearer_token_missing`, 1004 `invalid_claims`,
   * 1600 `forbidden`, 2001 `authorization_model_not_found`, and the rest of
   * errors_ignore.proto.
   *
   * IT SITS BESIDE `grpc_code` RATHER THAN REPLACING IT because they answer
   * different questions and a reader needs both: `grpc_code` is what the
   * transport concluded and therefore what the mesh, the proxy and any hop
   * telemetry will have recorded (always `internal` for these), while
   * `openfga_code` is what the service actually said and is the only one that
   * can be looked up. Collapsing them would make an OpenFGA auth refusal
   * indistinguishable from a genuine transport fault in exactly the records
   * used to tell them apart.
   */
  openfga_code?: number;
  /** Why, when the code does not say: `bad_body`, `token_mint_failed`, `rest_url_configured`. */
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
  grpcCode?: string;
  openfgaCode?: number;
  reason?: string;
}

interface CacheEntry extends Decision {
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Decision>>();
const counters = new Map<string, number>();
let warnedUnconfigured = false;
let warnedRestUrl = false;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE gRPC CLIENT, HELD RATHER THAN REBUILT.
 *
 * One client per endpoint, kept for the life of the process, because a
 * transport is a CONNECTION and not a request. Building one per Check would
 * open a fresh TCP connection and an HTTP/2 handshake for every entitlement
 * question on a user-facing read path — the hot path this module's cache exists
 * to protect — and would do it through the mesh proxy, which then has a new
 * connection to authenticate each time.
 *
 * THE SESSION MANAGER IS HELD SEPARATELY so the connection can be ABORTED. A
 * `Transport` has no close, and an http2 session that outlives its server keeps
 * a socket and a 15-minute idle timer alive; in a test suite that starts a fake
 * on a new port per case, that is a handle leak measured in test files. The
 * manager is the only handle on it, so the reset seam holds one.
 * ─────────────────────────────────────────────────────────────────────────────
 */
interface CheckClient {
  baseUrl: string;
  client: Client<typeof OpenFGAService>;
  sessions: Http2SessionManager;
}

let checkClient: CheckClient | null = null;

const dropCheckClient = (): void => {
  checkClient?.sessions.abort();
  checkClient = null;
};

function clientFor(baseUrl: string): Client<typeof OpenFGAService> {
  if (checkClient !== null && checkClient.baseUrl === baseUrl) return checkClient.client;
  // A changed endpoint is a changed connection: drop the old one rather than
  // leaving it open against an address nothing will use again.
  dropCheckClient();
  const sessions = new Http2SessionManager(baseUrl);
  // NO `httpVersion` OPTION, and its absence is the point rather than an
  // oversight. Connect v1 made the caller say `httpVersion: '2'`; v2's gRPC
  // transport dropped it because gRPC has no other version to be — it is
  // HTTP/2 by construction. There is therefore no value of any option here
  // that could silently put this hop back on HTTP/1.1.
  const transport = createGrpcTransport({ baseUrl, sessionManager: sessions });
  checkClient = { baseUrl, client: createClient(OpenFGAService, transport), sessions };
  return checkClient.client;
}

/**
 * The gRPC status name for the record, as gRPC itself spells them:
 * `Code.PermissionDenied` becomes `permission_denied`.
 */
const grpcCodeName = (code: Code): string => {
  const name: string | undefined = Code[code];
  return name === undefined
    ? `code_${String(code)}`
    : name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OPENFGA DOES NOT SPEAK CANONICAL gRPC STATUSES.
 *
 * gRPC defines codes 0–16. OpenFGA writes its OWN numbers into the
 * `grpc-status` trailer — `bearer_token_missing` is 1010, `invalid_claims` is
 * 1004, `authorization_model_not_found` is 2001 (openfga/api
 * errors_ignore.proto). Connect refuses a status outside the canonical range
 * and reports `Code.Internal` with the message "invalid grpc-status: 1010",
 * handing the RAW TRAILER through as the error's metadata. So a client that
 * keys its re-mint on `Code.Unauthenticated` never re-mints against the real
 * service: measured on v1.5.9 and v1.20.0, the stale-token rotation that used
 * to buy one re-mint under REST produced a permanent error-deny instead.
 *
 * THE RULE IS THE RANGE, NOT A LIST OF OBSERVED CODES, and that is not
 * fastidiousness — it is what the measurement forced. The same seven cases on
 * two versions:
 *
 *            no bearer   expired   wrong aud   wrong iss   malformed   bad model
 *   v1.5.9      1010      1005       1002        1003        1005        2001
 *   v1.20.0     1010      1004       1004        1004        1004        2001
 *
 * The codes MOVED. A fix that enumerated the three anyone had seen would have
 * been correct on one version and silently wrong on the other — and on v1.5.9
 * the expired-token case, which is the whole reason this exists, emits 1005 and
 * would have been missed by every list that did not already know to include it.
 *
 * So the boundary is OpenFGA's own, taken from its HTTP transcoding, which is
 * the behaviour being carried across: every AuthErrorCode below `forbidden`
 * transcodes to 401, and `forbidden` transcodes to 403. The old client retried
 * 401 and never retried 403. Therefore 1000–1599 buys one re-mint, 1600 buys
 * none, and everything else — the 2xxx ErrorCode family, and any number from a
 * future version or a middlebox — fails closed with the number recorded.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const OPENFGA_AUTH_MIN = 1000;
/** `forbidden`, which transcodes to 403 and which a fresh token cannot fix. */
const OPENFGA_FORBIDDEN = 1600;

/** Canonical gRPC space: 0 is OK, 1–16 are the codes Connect knows. */
const isCanonicalStatus = (value: number): boolean => value === 0 || value in Code;

/**
 * The number OpenFGA actually sent, or undefined when the status was a
 * canonical gRPC one.
 *
 * TWO PLACES IT CAN BE, because Connect parses trailers two ways. Normally the
 * raw `grpc-status` survives on the error's metadata and `code` is
 * `Code.Internal`. If the server sends `grpc-status-details-bin` instead,
 * Connect reads the protobuf Status and puts its number straight into `code`,
 * so a non-canonical value arrives THERE. Neither is hypothetical enough to
 * leave to chance, and reading both costs one comparison.
 */
function openFgaStatusOf(err: ConnectError): number | undefined {
  const trailer = err.metadata.get('grpc-status');
  if (trailer !== null) {
    const parsed = Number(trailer);
    if (Number.isInteger(parsed) && !isCanonicalStatus(parsed)) return parsed;
  }
  const code: number = err.code;
  return isCanonicalStatus(code) ? undefined : code;
}

/** Longest failure text this module will print. A trailer is not a log budget. */
const MAX_ERROR_TEXT = 200;

/**
 * THE MESSAGE IS TEXT THE FAR SIDE CHOSE, and it goes through here before it
 * goes anywhere near a log.
 *
 * Connect puts `grpc-message` VERBATIM into the error's message for a canonical
 * code. A service, a proxy or a debug build that echoes the Authorization
 * header back — "unauthenticated: Bearer eyJ…" is an entirely plausible thing
 * for one to say — therefore lands this process's credential in the application
 * log, which is shipped to an aggregator. It need not be malicious to happen.
 *
 * THE PRESENTED TOKEN IS REMOVED BY IDENTITY, NOT BY PATTERN. This module knows
 * exactly which bearer it just sent, so it can delete that string rather than
 * guess at what a credential looks like — no regex to be wrong about. The
 * `Bearer …` rule is the second line, for a credential that is not ours (a
 * neighbour's token quoted back by a shared gateway). And the whole thing is
 * bounded, because a 50 KB trailer is otherwise a 50 KB log line, once per read.
 */
function safeFailureText(text: string, presentedToken: string | undefined): string {
  let out = text;
  if (presentedToken !== undefined && presentedToken !== '') {
    out = out.split(presentedToken).join('[redacted]');
  }
  out = out.replace(/\bBearer\s+\S+/gi, '[redacted-credential]');
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}… (${String(out.length)} chars)` : out;
}

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
  warnedRestUrl = false;
  // The connection too, not only the maps: a suite that starts a fake OpenFGA
  // per case would otherwise leave one live http2 session per case pointing at
  // a port nothing is listening on.
  dropCheckClient();
};

/**
 * A positive finite number from the environment, or the default.
 *
 * STRICTLY GREATER THAN ZERO. Every value read through this is a BOUND — a
 * timeout, a cache lifetime, a map size — and zero is not a smaller bound, it
 * is the absence of one. A single typo in a deployment would otherwise break
 * the Check on a user-facing read path, and the two transports break it in
 * OPPOSITE directions: axios read `timeout: 0` as "wait forever" and hung the
 * read, while a gRPC deadline of zero has already expired when the call starts
 * and denies every request instantly. Neither is a bound, both are outages, and
 * the guard that refuses zero is the same one. A nonsensical value falls back
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
  /** Present when the call was attempted, so `unavailable` is distinguishable from `unauthenticated`. */
  grpcCode?: string;
  /** OpenFGA's own number, when it sent one outside the canonical gRPC range. */
  openfgaCode?: number;
  /** Why, when the reason is not simply the code. */
  reason?: string;
}

/**
 * Ask OpenFGA, over gRPC. Resolves to `true` ONLY on an explicit
 * `allowed: true`; everything else resolves to `false` and is counted as an
 * error rather than a deny, so an operator can tell a revoked user apart from a
 * sick dependency.
 *
 * FAIL CLOSED ON ANY NON-OK CODE, and that rule needed re-earning rather than
 * re-typing. Under axios the rule was inherited: its default `validateStatus`
 * rejects every non-2xx, so a proxy's fast 504 during a mesh partition arrived
 * as a rejection and denied without this file doing anything. gRPC has no such
 * default to inherit and no status class to reason about — a call either
 * resolves with a message or throws a ConnectError carrying a Code, and EVERY
 * code is a throw. So the rule is now explicit and total: the only path that
 * returns a grant is the one that got a message with `allowed === true`, and
 * the catch below does not enumerate codes at all, because enumerating them is
 * how a class nobody thought of becomes the class that fails open. Pinned by
 * test/entitlements/fail-closed.test.ts across the codes a partitioned or
 * refusing OpenFGA actually produces.
 *
 * ONE RETRY, ONLY ON `unauthenticated`, ONLY ON THE OIDC PATH. This is the 401
 * rule carried across: a cached token that expired or was rotated under us is
 * the one failure a retry can fix, and it is bounded at one. Re-mint, ask
 * again, and if the answer is still `unauthenticated` the credential is wrong
 * rather than stale — looping would turn that into a request storm against the
 * identity provider, which is measured in test/entitlements/mint-storm.test.ts.
 *
 * THE REST ENDPOINT IS REFUSED, NOT IGNORED. See the OPENFGA_API_URL branch.
 */
async function check(subject: string, env: NodeJS.ProcessEnv, nowMs: number): Promise<CheckOutcome> {
  // A MANIFEST THAT STILL SETS THE OLD VARIABLE IS A FAULT, NOT A FALLBACK.
  // There is no HTTP path left in this module, so an OPENFGA_API_URL carried
  // over from a pre-gRPC deployment cannot do what its author intended; the
  // only question is whether it fails loudly or silently. Silently would mean
  // the operator keeps a variable they believe is in use, and the transport
  // rule is quietly half-applied. initOpenFgaTransport refuses it at BOOT,
  // which is the intended failure; this branch is the second line, for a host
  // that never called it — the module must not be capable of a REST Check even
  // when its boot wiring is skipped.
  if ((env.OPENFGA_API_URL?.trim() ?? '') !== '') {
    bump('rest_url_configured');
    if (!warnedRestUrl) {
      warnedRestUrl = true;
      console.error(`[ENTITLEMENT] ${REST_URL_REFUSAL}`);
    }
    return { allowed: false, errored: true, reason: 'rest_url_configured' };
  }

  const grpcUrl = env.OPENFGA_GRPC_URL?.trim();
  const storeId = env.OPENFGA_STORE_ID?.trim();
  if (!grpcUrl || !storeId) {
    bump('unconfigured');
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        '[ENTITLEMENT] OpenFGA is not configured (OPENFGA_GRPC_URL / OPENFGA_STORE_ID) — every entitlement check denies and spine reads come back redacted. Expected until the authz substrate is wired.'
      );
    }
    return { allowed: false, errored: false, reason: 'unconfigured' };
  }

  const request = {
    storeId,
    tupleKey: {
      user: `user:${subject}`,
      relation: INVENTORY_LEVELS,
      object: env.OPENFGA_APP_OBJECT?.trim() || DEFAULT_APP_OBJECT,
    },
    // Pinning the model id makes the answer reproducible across a model
    // rollout; without it OpenFGA evaluates against whatever the latest model
    // is. proto3 gives a scalar string no presence, so unset and empty are the
    // same bytes and mean the same thing to OpenFGA — the JSON body omitted the
    // key, and an empty string here is that same decision spelled for protobuf.
    authorizationModelId: env.OPENFGA_MODEL_ID?.trim() ?? '',
  };

  const timeout = num(env.OPENFGA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const canRemint = openFgaAuthMode(env) === 'oidc';
  let reminted = false;
  /**
   * The bearer this Check last put on the wire, so an `unauthenticated` can say
   * WHICH token was refused rather than only that one was.
   *
   * Without it the retry clears whatever the shared cache happens to hold, and
   * a fleet of subjects being refused together each destroys the token the
   * others were about to use — 26 mints for 50 subjects, measured. It is a
   * credential in a local, never logged and never stored beyond this call.
   */
  let presentedToken: string | undefined;

  for (;;) {
    const auth = await openFgaAuthHeaders(
      env,
      nowMs,
      reminted ? { forceRefresh: true, presentedToken } : {},
    );
    if (auth === undefined) {
      // A credential IS configured and could not be obtained. Never fall
      // through to an unauthenticated Check: OpenFGA would answer
      // `unauthenticated` and the outcome would be identical, but the record
      // would name the wrong cause.
      return { allowed: false, errored: true, reason: 'token_mint_failed' };
    }

    const bearer = auth['authorization'];
    presentedToken = bearer?.startsWith(BEARER) === true ? bearer.slice(BEARER.length) : undefined;

    try {
      const response: unknown = await clientFor(grpcUrl).check(request, {
        // The deadline as gRPC expresses one: a per-call timeout that travels
        // to the server as `grpc-timeout` rather than a socket setting only
        // this side knows about. The far end can therefore stop working on a
        // question nobody is waiting for any more.
        timeoutMs: timeout,
        // The credential as gRPC METADATA. On the wire these are HTTP/2 header
        // fields on the stream, which is exactly what OpenFGA's `authn.method:
        // oidc` reads. There is no body to hide it in and no redirect to drop
        // it on: gRPC has no redirects, which retires a whole class of trap
        // this file used to carry an option for.
        headers: auth,
      });
      // WHAT A DECODED MESSAGE DOES AND DOES NOT PROVE. Protobuf is
      // structurally typed on the wire — a payload carries field numbers, never
      // a type name — so ANY message whose field 1 is a nonzero varint decodes
      // here as `{allowed: true}`. `$typeName` cannot help: protobuf-es derives
      // it from the schema the bytes were decoded WITH, so checking it compares
      // a constant to itself. What bounds this is not the decode: the request
      // names the store and the pinned model, the stream is
      // POST /openfga.v1.OpenFGAService/Check, and the peer is authenticated by
      // the mesh — an identity able to answer this RPC at all could simply
      // reply `true` honestly. Pinned, with the reasoning, in
      // test/entitlements/wire-surprise.test.ts.
      const allowed: unknown = (response as { allowed?: unknown } | null | undefined)?.allowed;
      if (typeof allowed !== 'boolean') {
        // UNREACHABLE THROUGH THE REAL CLIENT, AND KEPT ANYWAY. The generated
        // types make `allowed` a boolean and proto3 gives it a default, so a
        // resolved call always has one; every way the wire can surprise this
        // module — a non-gRPC content type, a payload that does not decode, a
        // missing message — arrives as a thrown ConnectError instead, and those
        // are covered in test/entitlements/wire-surprise.test.ts.
        //
        // It stays because the alternative is trusting a third-party package's
        // type declarations for a security decision, which is the one thing
        // this file's header refuses to do. The cost is exact and is disclosed
        // rather than chased: these two lines are the only uncovered ones in
        // this file (98.66% line, 98.16% branch, against an 85% gate). Do not
        // "fix" the number by deleting the guard.
        console.error('[ENTITLEMENT] OpenFGA Check response has no boolean `allowed` — denying');
        return { allowed: false, errored: true, grpcCode: 'ok', reason: 'bad_body' };
      }
      return { allowed, errored: false, grpcCode: 'ok' };
    } catch (err) {
      // `from` normalises: a ConnectError keeps its code, and anything else the
      // transport throws becomes `unknown` rather than escaping the rule.
      const connectError = ConnectError.from(err);
      const code = connectError.code;
      // READ OPENFGA'S OWN NUMBER BEFORE MAPPING ANYTHING. See the block above
      // openFgaStatusOf: every OpenFGA auth refusal arrives as Code.Internal,
      // so a decision made on `code` alone is a decision made on the transport's
      // opinion of a status it did not understand.
      const openfgaCode = openFgaStatusOf(connectError);
      const staleCredential =
        openfgaCode === undefined
          ? code === Code.Unauthenticated
          : openfgaCode >= OPENFGA_AUTH_MIN && openfgaCode < OPENFGA_FORBIDDEN;
      if (staleCredential && canRemint && !reminted) {
        reminted = true;
        bump('reminted');
        continue;
      }
      // NEVER THE ERROR OBJECT, and never the message raw either — see
      // safeFailureText. A ConnectError carries response `metadata`, a `cause`
      // holding the underlying socket error, and a message the far side wrote.
      // ONE VOCABULARY PER FIELD. `grpc_code` is the TRANSPORT's, and Connect
      // hands the same OpenFGA refusal over in two shapes depending on how the
      // server encoded it: from the plain `grpc-status` trailer the code is
      // `Code.Internal`, but from `grpc-status-details-bin` Connect reads the
      // number straight into `code`, which would put `code_1004` into a field
      // where every other record holds a gRPC name. One encoding choice by the
      // server would then split one condition across two values in the field
      // used to group them. So a non-canonical number is always reported as
      // the code Connect assigns when it cannot interpret a status —
      // `internal` — and the number lives in `openfga_code` and nowhere else.
      const grpcCode = grpcCodeName(openfgaCode === undefined ? code : Code.Internal);
      console.error(
        '[ENTITLEMENT] OpenFGA Check failed — denying:',
        `grpc=${grpcCode}${openfgaCode === undefined ? '' : ` openfga=${String(openfgaCode)}`}`,
        safeFailureText(connectError.rawMessage, presentedToken),
      );
      return {
        allowed: false,
        errored: true,
        grpcCode,
        ...(openfgaCode === undefined ? {} : { openfgaCode }),
      };
    }
  }
}

/**
 * THE BOOT LINE, AND THE BOOT REFUSAL. Call once, at startup, beside
 * initOpenFgaAuth — that one says which CREDENTIAL is in use, this one says
 * which WIRE carries it, and an operator diagnosing a denied read needs both.
 *
 * IT THROWS ON OPENFGA_API_URL. A pod that refuses to start is a worse outage
 * than one that starts, and that is the point: the alternative is a deployment
 * whose manifest still names the HTTP endpoint, whose operator believes the
 * hop is configured, and whose every entitlement read comes back redacted with
 * nothing but a recurring log line to say why. Crash-looping with the rename in
 * the message is the failure an operator can act on in one reading, and it is
 * the only state that cannot be mistaken for "the transport rule is applied".
 *
 * Returns the endpoint it will dial, so a host that wants to log it its own way
 * can, and so a test can assert the line without parsing the console.
 */
export function initOpenFgaTransport(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.OPENFGA_API_URL?.trim() ?? '') !== '') throw new Error(REST_URL_REFUSAL);

  const raw = env.OPENFGA_GRPC_URL?.trim() ?? '';
  if (raw === '') {
    console.warn('[ENTITLEMENT] openfga: grpc h2c (OPENFGA_GRPC_URL unset) — every entitlement check denies');
    return '';
  }
  let authority = raw;
  let wire = 'grpc h2c';
  try {
    const url = new URL(raw);
    authority = url.host;
    // h2c is CLEARTEXT http/2 — correct inside the mesh, where the Linkerd
    // proxy adds mTLS and the pod-local hop is plaintext by design. An https
    // endpoint is a different thing and must not be described as h2c, or the
    // boot line becomes the reason someone believes a hop is meshed.
    wire = url.protocol === 'https:' ? 'grpc h2 tls' : 'grpc h2c';
  } catch {
    // An unparseable URL is left to fail at the first call with the transport's
    // own message; this line exists to say what was configured, not to validate
    // it twice in two different vocabularies.
    authority = '(unparseable)';
  }
  console.log(`[ENTITLEMENT] openfga: ${wire} ${authority}`);
  return raw;
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
      ...(decision.grpcCode === undefined ? {} : { grpc_code: decision.grpcCode }),
      ...(decision.openfgaCode === undefined ? {} : { openfga_code: decision.openfgaCode }),
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
    // Elapsed time, so performance.now() and NOT Date.now(): the latter is not
    // monotonic, and on this estate's WSL2 hosts it steps backwards by about a
    // second often enough that commit fef12ca on this very branch had to fix
    // the identical pattern in a test, where it produced a measured -933.
    // Applying that fix to the test and not to the production measurement would
    // have left the audit record free to carry a negative latency.
    //
    // `nowMs` is untouched by this: it is a fixed instant the caller chose for
    // cache arithmetic, not a stopwatch.
    const startedAt = performance.now();
    const outcome = await check(subject, env, nowMs);
    const latencyMs = Math.round(performance.now() - startedAt);

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
      ...(outcome.grpcCode === undefined ? {} : { grpcCode: outcome.grpcCode }),
      ...(outcome.openfgaCode === undefined ? {} : { openfgaCode: outcome.openfgaCode }),
      ...(outcome.reason === undefined || outcome.reason === 'unconfigured'
        ? {}
        : { reason: outcome.reason }),
    };

    const ttl = outcome.errored
      ? num(env.ENTITLEMENT_GRANT_ERROR_TTL_MS, DEFAULT_ERROR_TTL_MS)
      : num(env.ENTITLEMENT_GRANT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
    cacheSet(subject, { ...decision, expiresAt: nowMs + ttl }, nowMs, env);

    // `source` NAMES WHERE THE ANSWER CAME FROM, and three decisions reach here
    // having made no request at all: an unconfigured client, which returns
    // before a request is even built; a failed token mint, which refuses to ask
    // unauthenticated; and a retired OPENFGA_API_URL, which is refused before
    // an endpoint is chosen. Reporting any of them as `openfga` says the service
    // answered when it was never asked — and this is the one field separating a
    // refusal by OpenFGA and a question that never got there, so anyone
    // counting OpenFGA traffic by it would over-count by exactly the outage
    // they are diagnosing. `bad_subject` already gets this right above.
    //
    // NOTE TO A FUTURE EDITOR: anywhere in this directory, comments included,
    // do not write the word `from` immediately before a quoted string, and do
    // not write either of the two dynamic-import keywords immediately followed
    // by an opening parenthesis. The portability guard's specifier extractor
    // does not strip comments — on purpose, since a partial guard is worse than
    // none — so it reads those shapes as imports and fails the build.
    //
    // Both rules were paid for. The first cost this comment a rewrite; the
    // second cost it another, on the same day the guard learned that a space
    // before the parenthesis is legal and that it had been ignoring every such
    // import since it was written.
    const asked =
      name !== 'unconfigured' &&
      outcome.reason !== 'token_mint_failed' &&
      outcome.reason !== 'rest_url_configured';
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
