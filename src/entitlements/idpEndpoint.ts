/**
 * idpEndpoint.ts — ONE RULE FOR EVERY URL THAT NAMES THE IDENTITY PROVIDER, and
 * the only place in this service where cleartext is ever accepted.
 *
 * WHY IT EXISTS. Two settings name Authentik and they were governed by two
 * copies of the same rule, in two files, with two slightly different messages:
 * `OIDC_JWKS_URI` in ../auth/config.ts and `OPENFGA_OIDC_TOKEN_ENDPOINT` here.
 * Both said "https, unless it is loopback". R7 relaxes that for exactly one
 * host shape, and a relaxation applied to a duplicated rule is a relaxation
 * applied to whichever copy someone remembered.
 *
 * WHAT R7 IS. fc-infra mirrors Authentik across the Linkerd multicluster link
 * that already carries the OpenFGA hop, so the coordinator's two OIDC calls
 * stop leaving the cluster. Today they cross the public internet under one-way
 * TLS, carrying the OpenFGA service account's password — the strongest single
 * credential in the estate travelling the weakest-authenticated path in it. On
 * the mirror the hop is mesh mTLS on the wire and CLEARTEXT inside the pod,
 * because the Linkerd proxy is what encrypts it. So https cannot be required
 * there, and must still be required everywhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 *
 *   https                    accepted. Unchanged, and no header is added.
 *   loopback                 accepted. A local test issuer is not a hop anyone
 *                            can sit on. Unchanged.
 *   *.svc.cluster.local      accepted over http — AND IDP_PUBLIC_HOST becomes
 *                            REQUIRED, and every request presents it.
 *   anything else over http  REFUSED, with the message the call site already
 *                            had, unchanged to the byte.
 *
 * WHY THE PUBLIC HOST IS MANDATORY ON THE MESH PATH rather than a nicety.
 * Authentik derives the issuer from the REQUEST — `request.build_absolute_uri`,
 * in BOTH issuer modes, read from its source — so the `iss` of a token minted
 * through the mirror is built out of the `Host` header and `X-Forwarded-Proto`.
 * Reached as the mirror with no headers, it mints
 * `http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/…`,
 * OpenFGA's pinned issuer refuses every one of them, and the user-visible
 * result is reads coming back redacted with nothing in the log naming the
 * cause. A mesh URL without a public host is not a working configuration
 * missing a refinement; it is a configuration that denies everything. It fails
 * at boot.
 *
 * `OIDC_ISSUER` DOES NOT CHANGE and must not: it is compared against the `iss`
 * claim, never dialled. Only the network path moves.
 *
 * WHY THE SUFFIX IS A CONSTANT AND NOT AN ENVIRONMENT VARIABLE. Its value
 * decides where a password may be posted in the clear. ./openfgaToken.ts
 * already states the rule for that class of setting — "a flag whose whole
 * purpose is to disable a transport requirement is a flag that eventually gets
 * set in production by someone in a hurry" — and a suffix env is that flag
 * wearing a DNS name. A cluster whose domain is not `cluster.local` changes
 * this line, in a diff, with a reviewer.
 *
 * AND THE MATCH IS ON A LABEL BOUNDARY, not `includes('cluster')` and not a
 * bare `endsWith`: `authentik.evilsvc.cluster.local` ends with the suffix as a
 * STRING and is a domain anyone can register under. Only the empty label
 * before it makes it the cluster's own namespace.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PORTABILITY: this file imports nothing at all, so it travels with the
 * directory and can also be used by the host's own configuration — which is
 * exactly what ../auth/config.ts does with it. See ./index.ts.
 */

/** The cluster's DNS domain. See the header for why this is not configurable. */
export const MESH_HOST_SUFFIX = 'svc.cluster.local';

/** The public authority every mesh-path request presents. */
export const IDP_PUBLIC_HOST_KEY = 'IDP_PUBLIC_HOST';

/**
 * The same set ../auth/config.ts used, kept verbatim. `[::1]` and `::1` are
 * both here because the URL parser brackets an IPv6 literal in `hostname` and
 * a hand-written value may not.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Frozen, and shared: an empty header set is the SAME absence everywhere. */
const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Which of the three shapes the configured URL is.
 *
 *   public    the internet, over https
 *   mesh      the in-cluster mirror
 *   loopback  a local issuer, which every fixture in the suite is reached over
 */
export type IdpPathKind = 'public' | 'mesh' | 'loopback';

export interface IdpPath {
  kind: IdpPathKind;
  /** Dialled exactly as configured. The headers are what differ, never the target. */
  url: URL;
  /** The authority presented. Set on the mesh path, and on loopback when configured. */
  publicHost?: string;
  /**
   * Sent on EVERY request over this path, lower-cased because that is how both
   * clients and the Headers class normalise them. Empty on the public path:
   * a hop that dials the public authority already presents it, and adding a
   * header there would make two paths differ for no reason.
   */
  headers: Readonly<Record<string, string>>;
  /** One line for the boot log, naming the path and what it presents. */
  description: string;
}

export type IdpPathResult = { ok: true; path: IdpPath } | { ok: false; reason: string };

export interface IdpPathOptions {
  /** The environment variable being resolved. It appears in every message. */
  key: string;
  env: NodeJS.ProcessEnv;
  /**
   * Appended to the https refusal. The token endpoint adds why the rule is
   * stricter there than on a URL that only carries public keys; the JWKS URI
   * adds nothing. Both messages stay byte-identical to what they were.
   */
  refusalSuffix?: string;
}

/**
 * Is this host inside the cluster? A label boundary, so a registrable domain
 * ending in the same characters is not the cluster's namespace.
 */
const isMeshHost = (hostname: string): boolean =>
  hostname === MESH_HOST_SUFFIX || hostname.endsWith(`.${MESH_HOST_SUFFIX}`);

/**
 * A bare authority — `host` or `host:port` — and nothing else.
 *
 * Validated by parsing it AS an authority and requiring the parser to agree:
 * anything carrying a scheme, a path, userinfo or whitespace comes back with a
 * different `host` and is refused. Refusing an in-cluster name here is not
 * pedantry — it is the precise own-goal this whole rule exists to prevent,
 * spelled as a configuration: a "public" host that is a second mirror name
 * mints tokens OpenFGA refuses, silently, exactly as no header at all would.
 */
function validatePublicHost(raw: string | undefined, key: string): IdpPathResult | string {
  const value = (raw ?? '').trim();
  if (value === '') {
    return {
      ok: false,
      reason:
        `${IDP_PUBLIC_HOST_KEY} is required when ${key} names an in-cluster host: Authentik builds the token's ` +
        `'iss' from the request, so a mint through the mirror without it names the mirror and OpenFGA refuses every token`,
    };
  }

  const invalid: IdpPathResult = {
    ok: false,
    reason: `${IDP_PUBLIC_HOST_KEY} must be a bare host or host:port with no scheme, path or userinfo, got '${value}'`,
  };

  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    return invalid;
  }
  if (parsed.host !== value.toLowerCase() || parsed.username !== '' || parsed.password !== '') {
    return invalid;
  }
  if (isMeshHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        `${IDP_PUBLIC_HOST_KEY} must be the PUBLIC authority the identity provider is reached at, ` +
        `not another in-cluster name, got '${value}'`,
    };
  }
  return parsed.host;
}

/**
 * Classify a configured IdP URL, or say why it is refused.
 *
 * The URL is PARSED BY THE CALLER, deliberately: the two call sites disagree
 * about whether an unparseable value may be echoed back — one of them may
 * carry `user:password@` in it and has its own redaction — and that difference
 * is theirs to keep.
 */
export function resolveIdpPath(url: URL, options: IdpPathOptions): IdpPathResult {
  const { key, env, refusalSuffix = '' } = options;
  const mesh = isMeshHost(url.hostname);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);

  if (!mesh && !loopback) {
    // THE RULE THAT IS NOT BEING RELAXED, and its message is unchanged to the
    // byte so a test pinning it keeps pinning it.
    if (url.protocol !== 'https:') {
      return {
        ok: false,
        reason: `${key} must use https (got '${url.protocol}') unless it is loopback${refusalSuffix}`,
      };
    }
    return {
      ok: true,
      path: {
        kind: 'public',
        url,
        headers: NO_HEADERS,
        description: `public https ${url.host}`,
      },
    };
  }

  // Loopback with nothing configured is exactly what it always was.
  const configured = (env[IDP_PUBLIC_HOST_KEY] ?? '').trim();
  if (loopback && !mesh && configured === '') {
    return {
      ok: true,
      path: { kind: 'loopback', url, headers: NO_HEADERS, description: `loopback ${url.host}` },
    };
  }

  const validated = validatePublicHost(env[IDP_PUBLIC_HOST_KEY], key);
  if (typeof validated !== 'string') return validated;

  const kind: IdpPathKind = mesh ? 'mesh' : 'loopback';
  return {
    ok: true,
    path: {
      kind,
      url,
      publicHost: validated,
      // `x-forwarded-proto` is the header Django reads for the SCHEME half of
      // the issuer, and it is https because the public issuer is https. It is
      // not derived from this hop, which is the whole point: this hop is
      // cleartext and the issuer must not say so.
      headers: Object.freeze({ host: validated, 'x-forwarded-proto': 'https' }),
      description: `${kind === 'mesh' ? 'mesh mirror' : 'loopback'} ${url.host} presenting Host ${validated}`,
    },
  };
}
