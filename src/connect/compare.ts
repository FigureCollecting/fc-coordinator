// ============================================================================
// coordinator.v1.CompareService — the Compare PASS-THROUGH (plan §C slice 1
// item 6, contract coordinator/v1/compare.proto).
//
// WHAT THIS SERVICE ADDS, AND WHAT IT MUST NOT. It adds authentication (the
// edge, upstream of here), authorisation (an OpenFGA Check, then a 60-second
// Ed25519 assertion minted SERVER-SIDE and attached to the mesh hop), and
// nothing else. The spine's answer crosses back untouched. Any re-derivation
// here would be a second source of truth for a verdict fc-aggregation already
// owns, and the two would drift on the first schema change.
//
// TWO THINGS THE HANDLER DOES TO THE ANSWER, both copies:
//
//   result_json  is returned BYTE FOR BYTE. It is never parsed and
//                reserialised. read.v1's fidelity doctrine keeps every scraped
//                token as raw TEXT precisely so a float64 round trip cannot
//                corrupt a long amount or a product code, and a JSON.parse ->
//                JSON.stringify here would undo that at the last hop.
//
//   coverage     is LIFTED out of result_json — the same members in the same
//                order, and the same semanticsRev string. Copied, never
//                computed, never filtered, never sorted. It exists so a client
//                can decide whether to render an "unavailable to you"
//                affordance without parsing the blob.
//
// WHY AN UNLIFTABLE RESPONSE IS REFUSED RATHER THAN EMPTIED. A response whose
// coverage cannot be read is a response nobody can vouch for. Returning it with
// an empty `redacted` would state "you saw everything the spine holds" — the
// confident zero the whole redaction contract exists to prevent, and worse than
// an error because it looks like an answer. So: INTERNAL, with a message that
// says what happened and quotes none of the payload.
//
// A DENIAL IS NOT AN ERROR. Unentitled, unlinked, denied, OpenFGA unreachable,
// no signing key, nobody authenticated — every one of those arrives here as "no
// assertion", and the spine answers each with a normal 200 whose magnitudes are
// withheld and marked in coverage.redacted. Nothing on that path throws and
// nothing changes a status code: a gate that answers differently when it fails
// is an existence oracle.
// ============================================================================
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  CompareService,
  CompareResponseSchema,
  CoverageSchema,
  type CompareRequest,
  type CompareResponse,
} from '@figurecollecting/fc-api-contract';
import { COVERAGE_REDACTED_KEY } from '@figurecollecting/ingest-contract/entitlement';
import { entitlementHeaderFor as defaultEntitlementHeaderFor } from '../entitlements/index.js';
import { kCallerSubject } from './identity.js';

/** The seed shape src/spine/spineReadClient.ts accepts. */
export type SpineSeed = { gtin14: string } | { headId: string };

/**
 * The narrow slice of SpineReadClient this handler needs. Declared here rather
 * than imported so a test can supply a two-line stand-in, and so the handler
 * has no opinion about the transport.
 */
export interface SpineCompare {
  compare(seed: SpineSeed, nowIso: string, assertion?: string | null): Promise<{ resultJson: string }>;
}

export interface CompareRoutesDeps {
  /**
   * `null` is the DEGRADED MODE seam: SPINE_READ_URL unset means no transport
   * was ever constructed, and every Compare answers UNAVAILABLE rather than
   * pretending to have asked.
   */
  spineRead: SpineCompare | null;
  /** Injectable for tests. Production uses the ported U6 module. */
  entitlementHeaderFor?: (subject: string) => Promise<string | null>;
}

/**
 * ISO-8601 with a MANDATORY time and a MANDATORY zone designator.
 *
 * Both are mandatory on purpose. `2026-09-14` parses in JavaScript as midnight
 * UTC, and a zoneless `2026-09-14T12:00:00` parses as LOCAL time — so accepting
 * either would let the caller's clock mean something different depending on
 * where the pod runs, and every orderability verdict is derived from that
 * clock. The shape is checked first and `Date.parse` second, because the regex
 * admits impossible instants like month 13 that only a parse can reject.
 */
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

export function isValidNowIso(value: string): boolean {
  return ISO_8601_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/** The coverage facts the client contract carries outside `result_json`. */
export interface LiftedCoverage {
  redacted: string[];
  semanticsRev: string;
}

/**
 * Read `coverage` out of a spine `result_json`. `null` means it could not be
 * lifted, and the caller must refuse rather than guess.
 *
 * STRICT ABOUT EVERY FIELD, deliberately. `redacted` is the dangerous one: a
 * wrong answer there is a confident zero on an unentitled surface. But
 * `semanticsRev` is strict too, because fc-aggregation stamps it on EVERY
 * CompareResult — it is required there, never optional — so its absence means
 * the answer did not come from a conforming spine, and an empty string would be
 * a hash that compares equal to the next unconforming answer.
 *
 * `redacted` ABSENT IS NOT AN ERROR. The spine stamps it only when something
 * was actually removed, and proto3's `repeated string` has no presence, so
 * spine-absent maps to wire-empty. That mapping is 1:1 and keeps the
 * distinction the field exists to draw: "no inventory data" versus "you may not
 * see it".
 */
export function liftCoverage(resultJson: string): LiftedCoverage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const coverage = (parsed as { coverage?: unknown }).coverage;
  if (typeof coverage !== 'object' || coverage === null || Array.isArray(coverage)) return null;

  const semanticsRev = (coverage as { semanticsRev?: unknown }).semanticsRev;
  if (typeof semanticsRev !== 'string') return null;

  const raw = (coverage as Record<string, unknown>)[COVERAGE_REDACTED_KEY];
  if (raw === undefined) return { redacted: [], semanticsRev };
  if (!Array.isArray(raw)) return null;
  if (!raw.every((name): name is string => typeof name === 'string')) return null;

  // Copied, in order. No sort, no dedupe, no filter to names we recognise: a
  // facet this build has never heard of is still a facet the client was denied.
  return { redacted: [...raw], semanticsRev };
}

/** Exactly one seed, non-blank, or INVALID_ARGUMENT before the mesh hop. */
function seedFrom(request: CompareRequest): SpineSeed {
  const seed = request.seed;
  if (seed.case === undefined || seed.value.trim() === '') {
    throw new ConnectError(
      'compare requires exactly one seed: gtin14 or head_id',
      Code.InvalidArgument,
    );
  }
  return seed.case === 'gtin14' ? { gtin14: seed.value } : { headId: seed.value };
}

/**
 * Build the CompareService routes.
 *
 * The subject arrives in the Connect handler context, put there by
 * identityContextValues() from whatever the edge established. This handler
 * never reads a token and never names a header.
 */
export function createCompareRoutes(deps: CompareRoutesDeps): (router: ConnectRouter) => void {
  const mint = deps.entitlementHeaderFor ?? ((subject: string) => defaultEntitlementHeaderFor(subject));

  const compare = async (
    request: CompareRequest,
    ctx: HandlerContext,
  ): Promise<CompareResponse> => {
    // Validate BEFORE anything leaves the process: a malformed request is the
    // caller's fault, and forwarding it would spend a mesh hop to learn that.
    const seed = seedFrom(request);
    if (!isValidNowIso(request.nowIso)) {
      throw new ConnectError(
        'now_iso must be an ISO-8601 instant with a time and a zone offset',
        Code.InvalidArgument,
      );
    }
    if (deps.spineRead === null) {
      throw new ConnectError('spine read is not configured', Code.Unavailable);
    }

    // null subject -> no Check, no mint, no header. Redacted, not rejected.
    const subject = ctx.values.get(kCallerSubject);
    const assertion = subject === null ? null : await mint(subject);

    let upstream: { resultJson: string };
    try {
      // now_iso forwarded as the caller's own characters: never restamped with
      // our wall time, never parse-then-reserialised through a Date.
      upstream = await deps.spineRead.compare(seed, request.nowIso, assertion);
    } catch (err) {
      // The upstream CODE is useful to an operator and is on the span; the
      // upstream MESSAGE routinely carries connection detail, so it is not
      // relayed. From the client's side the fact is the same either way: the
      // coordinator could not complete the read.
      throw new ConnectError('spine read is unavailable', Code.Unavailable, undefined, undefined, err);
    }

    const coverage = liftCoverage(upstream.resultJson);
    if (coverage === null) {
      throw new ConnectError(
        'spine returned a result whose coverage could not be lifted',
        Code.Internal,
      );
    }

    return create(CompareResponseSchema, {
      resultJson: upstream.resultJson,
      coverage: create(CoverageSchema, coverage),
    });
  };

  return (router: ConnectRouter) => {
    router.service(CompareService, { compare });
  };
}
