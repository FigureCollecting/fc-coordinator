# fc-coordinator

The backend fc-mobile talks to: OIDC + DPoP edge, entitlements, collections and
sync, on Postgres only. It replaces fc-backend for the mobile client rather than
extending it — there is no password, no TOTP and no WebAuthn here, because
identity belongs to Authentik.

This repository holds **slice 1a** (the skeleton: Fastify 5, `GET /healthz`, the
fc-shared telemetry baseline, the Postgres pool, migrations 0001-0002) and
**slice 1b-ent**: the ported U6 entitlement module, the spine read client, and
the `coordinator.v1` Compare pass-through served as Connect-Web. OIDC and DPoP
arrive on their own branch and plug into the identity seam described below.

## Requirements

- Node **>= 24.15.0** (inherited from the `@figurecollecting/fc-shared` BOM)
- Docker, for the migration test's Testcontainers Postgres
- A GitHub token with `read:packages` to install the private fc-shared package

## Install

```
NODE_AUTH_TOKEN=<read:packages PAT> npm ci
```

`.npmrc` maps the `@figurecollecting` scope to GitHub Packages and reads the
token from `NODE_AUTH_TOKEN`. It contains a placeholder, never a real token.

## Run

```
npm run dev      # tsx watch
npm run build    # tsc -> dist/ (ESM)
npm start        # node dist/server.js
```

| Variable | Default | Meaning |
|---|---|---|
| `COORDINATOR_PORT` | `5052` | listen port |
| `COORDINATOR_HOST` | `0.0.0.0` | listen address |
| `COORDINATOR_ROUTE_PREFIX` | `/api` | every route except `/healthz` is served under this. Set it to the empty string to serve at the root. **The edge must not rewrite it** — see below |
| `LOG_LEVEL` | `info` | trace / debug / info / warn / error / fatal / silent |
| `SERVICE_VERSION` | `unknown` | stamped into the image and reported by `/healthz` |
| `DATABASE_URL` | unset | full DSN; when unset the discrete `PG*` variables are used |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | libpq defaults | discrete connection settings |
| `PG_POOL_MAX` | `10` | pool size |
| `PGSSLMODE` | unset | `disable` \| `require` \| `verify-full`; production uses `verify-full` |
| `PGSSLROOTCERT` | unset | path to the CA PEM for `verify-full` (contents are read, not the path) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | collector endpoint; falls back to `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `SPINE_READ_URL` | unset | ingest-server Connect base URL; **unset means Compare answers `UNAVAILABLE`** and no transport is built |
| `SPINE_READ_TIMEOUT_MS` | `10000` | per-call deadline on the mesh hop |
| `OPENFGA_GRPC_URL` `OPENFGA_STORE_ID` | unset | the entitlement Check, which is **gRPC over h2c on port 8081** (e.g. `http://openfga-mc-fc-ha.authz.svc.cluster.local:8081`); **unset means every Check denies** |
| `OPENFGA_API_URL` | must be unset | the retired HTTP endpoint. **Setting it stops the process at boot**, naming the rename — there is no HTTP path left, so a manifest that still carries it would otherwise redact every read while looking configured |
| `OPENFGA_MODEL_ID` `OPENFGA_APP_OBJECT` `OPENFGA_TIMEOUT_MS` | unset / `app:figurecollecting` / `2000` | optional Check settings. `OPENFGA_TIMEOUT_MS` becomes the gRPC call deadline. A `0` is refused and falls back: a deadline of zero has already expired when the call starts and would deny every read instantly |
| `OPENFGA_OIDC_TOKEN_ENDPOINT` `OPENFGA_OIDC_CLIENT_ID` `OPENFGA_OIDC_USERNAME` `OPENFGA_OIDC_PASSWORD` | unset | the minted credential. **Setting any one of them puts the process on the OIDC path**, and a partial set fails closed there rather than degrading to an unauthenticated Check |
| `OPENFGA_OIDC_CLIENT_SECRET` `OPENFGA_OIDC_SCOPE` `OPENFGA_OIDC_REFRESH_SKEW_SECONDS` `OPENFGA_OIDC_TIMEOUT_MS` | unset / `openid` / `120` / `5000` | optional provider settings |
| `OPENFGA_API_TOKEN` | unset | the preshared token, for local runs and break-glass. **Ignored when the OIDC path is configured**, with one warning saying so |
| `ENTITLEMENT_SIGNING_KEY_PEM` or `ENTITLEMENT_SIGNING_KEY_FILE` | unset | the Ed25519 PKCS#8 signing key; **unset means no assertion is ever sent** |
| `ENTITLEMENT_SIGNING_KID` | unset (derived from a key FILE's basename) | the JOSE `kid`; production mints under `ent-2026-09` or the spine silently redacts |
| `ENTITLEMENT_SIGNING_ISSUER` | the contract's `ENTITLEMENT_ISSUER` | the `iss` claim. **Do not set this until ingest-server's verifier has been taught the new value** — see below |
| `ENTITLEMENT_GRANT_CACHE_TTL_MS` `ENTITLEMENT_GRANT_ERROR_TTL_MS` `ENTITLEMENT_GRANT_CACHE_MAX` | `30000` / `5000` / `10000` | grant cache bounds; a value that is not a positive number falls back to the default |

### The route prefix, and why the edge must not rewrite it

Production serves this behind `https://figurecollecting.com/api`, and the
service serves that path **itself**. That is not a style choice.

The DPoP `htu` check compares `COORDINATOR_PUBLIC_ORIGIN` plus the path **this
process received**. A `stripPrefix` at the edge would leave every client signing
a proof for `/api/coordinator.v1.CompareService/Compare` while the server
compared it against `/coordinator.v1.CompareService/Compare`, and every request
would come back 401 naming nothing in particular. So the prefix is served
natively and the tunnel forwards the path unchanged.

`/healthz` is the one exception and stays at the root. Only kubelet and the
image HEALTHCHECK reach it, both in-cluster and both by literal path, and the
public tunnel routes the prefix and nothing else — so leaving it unprefixed is
what keeps the one unauthenticated route off the public surface. A request to
`${prefix}/healthz` matches no route and gets the same 401 as anything else.

`test/connect/prefix.test.ts` pins the failure mode directly: a caller whose
token, key, device and nonce are all valid, but whose proof names the stripped
path, is rejected.

### The OpenFGA wire

The Check is **gRPC**, `openfga.v1.OpenFGAService/Check` on port 8081 over
cleartext h2c, with mesh mTLS added by the Linkerd proxy. It is not a second
API: upstream declares `Check` with a `google.api.http` annotation mapping it to
`POST /stores/{store_id}/check`, so the REST endpoint this service used until
now was a grpc-gateway transcoding **of** this service. Moving to gRPC moves to
the primary definition. (Ross, 2026-09-17: "communications between all api
endpoints … is to be gRPC (with mTLS, whether homegrown, mesh, or both)".)

The wire types are **vendored and generated in-repo**: `proto/openfga/v1/openfga_service.proto`
is a slice of `buf.build/openfga/api` carrying the Check and nothing else, and
the generated TypeScript is committed inside `src/entitlements/gen/` so the
portable directory travels whole. Regenerate with `npm run proto:generate`
(`buf generate`, via the `@bufbuild/buf` and `@bufbuild/protoc-gen-es`
devDependencies); CI compiles the committed output and never runs the generator.

The alternative was the buf registry's npm packages (`@buf/openfga_api.*`),
which would put a second external registry in the install path of every CI run
and every image build and pin the artifact to a protobuf-es version chosen by
the registry rather than by this repo. Vendoring costs a drift risk instead, and
`test/entitlements/openfga-wire.test.ts` is what pays it. The **actual upstream
file** is vendored as `test/fixtures/upstream-openfga_service.proto`, byte for
byte, with its sha256 asserted — the first version of that suite carried a
hand-copied table of field numbers, which is the same class of artifact as the
slice it was checking, and two hand-copies agreeing proves only that one hand
made the same decision twice. The numbers are now **parsed** out of upstream and
compared with the generated descriptor; the reserved set is **derived** as
"upstream's fields minus the ones the slice carries" rather than listed. CI does
not fetch anything, because a suite that goes red when GitHub is slow is a suite
people learn to ignore; the hash is what makes the offline copy evidence.

That test is not theoretical — the proof-of-concept this work was built on
numbered `authorization_model_id` 5, which upstream gives to `bool trace`, and it
passed because both ends of it used the same wrong slice.

### OpenFGA's own status numbers

**OpenFGA does not speak canonical gRPC statuses**, and this is the single
sharpest edge on the hop. gRPC defines codes 0–16; OpenFGA writes its own
numbers into the `grpc-status` trailer, from `errors_ignore.proto`:

| | |
|---|---|
| `AuthErrorCode` | 1001 invalid_subject · 1002 invalid_audience · 1003 invalid_issuer · 1004 invalid_claims · 1005 invalid_bearer_token · 1010 bearer_token_missing · 1500 unauthenticated · 1600 forbidden |
| `ErrorCode` | 2000 validation_error · 2001 authorization_model_not_found · … |

Connect-ES refuses a status outside the canonical range and reports
`Code.Internal` with the message `invalid grpc-status: 1010`, handing the raw
trailer through as the error's metadata. So a client that keys its re-mint on
`Code.Unauthenticated` **never re-mints against the real service** — the stale
token that bought one re-mint and a successful Check under REST becomes a
permanent error-deny. `grants.ts` therefore reads the number back off the
metadata **before** mapping anything.

**The rule is the range, not a list of observed codes**, and the measurement is
what forced that. The same seven cases against the real binary, OIDC authn mode:

| case | v1.5.9 | v1.20.0 |
|---|---|---|
| valid token, granted tuple | `0`, allowed | `0`, allowed |
| no bearer | 1010 | 1010 |
| expired token (the rotation shape) | **1005** | **1004** |
| wrong audience | 1002 | 1004 |
| wrong issuer | 1003 | 1004 |
| malformed token | 1005 | 1004 |
| unknown model id | 2001 | 2001 |

The codes **moved between versions**. A fix enumerating the three anyone had
seen would have been right on one version and silently wrong on the other, and
on v1.5.9 the expired-token case — the whole reason the fix exists — emits 1005.
So the boundary is OpenFGA's own, taken from its HTTP transcoding, which is the
behaviour being carried across: every `AuthErrorCode` below `forbidden`
transcodes to 401 and `forbidden` transcodes to 403; the old client retried 401
and never retried 403. **1000–1599 buys one re-mint, 1600 buys none, and
everything else fails closed with the number recorded.**

**The failure text never reaches the log raw.** Connect puts `grpc-message`
verbatim into the error's message for a canonical code, so a service, proxy or
debug build that echoes the Authorization header back would land this process's
credential in the application log. The bearer just presented is removed **by
identity** (this module knows exactly what it sent, so there is no pattern to be
wrong about), a generic `Bearer …` rule catches a credential that is not ours,
and the whole thing is bounded at 200 characters — a 50 KB trailer is otherwise
a 50 KB log line, once per read.

### The OpenFGA credential

The Check presents a **minted** token, not a configured one. The authorization
service authenticates callers against an OIDC provider whose tokens live ten
minutes, so a static environment value is correct for ten minutes and then
denies forever — silently, because an `unauthenticated` is caught, counted as an
error and turned into a deny. Every read would come back redacted with nothing in the log
but a recurring "Check failed".

- `client_credentials` with a **username and password**, which looks wrong and
  is not: the provider models this caller as a service account whose app
  password is presented beside the public client id. Both values are
  url-encoded, so a password containing `&`, `=` or `+` survives the wire.
- **Refreshed ahead of expiry** at `expires_in - OPENFGA_OIDC_REFRESH_SKEW_SECONDS`,
  floored at half the lifetime so a short token cannot schedule its refresh in
  the past and re-mint on every call.
- **Single-flight**: a cold start under load mints once.
- **Fails closed**: a mint failure denies and the Check is never made. Falling
  through to an unauthenticated Check would produce the same redacted read and
  a 401 in the log, sending an operator to the wrong system.
- An **`unauthenticated` from OpenFGA** buys exactly one forced re-mint, then a
  deny. One, not a loop: a credential that is wrong rather than stale must not
  become a request storm against the provider. `permission_denied` buys none —
  that is a decision, and a fresh token cannot change it.
- Two boot lines, because they answer different questions. The credential line
  names which path is active and says `INCOMPLETE` with the missing variable
  when the provider is only half configured. The transport line names the wire:
  `[ENTITLEMENT] openfga: grpc h2c <host>:8081`.

### The entitlement audit line

One structured line per decision, at info level, on `app.log`:

```json
{"event":"entitlement.check","subject":"<uuid>","relation":"inventory_levels",
 "object":"app:figurecollecting","decision":"allow","source":"openfga",
 "latency_ms":7,"model_id":"01K…"}
```

`decision` is `allow` / `deny` / `error` / `unconfigured` / `bad_subject`, and
`source` is `openfga` / `cache` / `coalesced` / `none`. A cache hit is a
decision and says so, replaying the **original** outcome — a cached error-deny
reported as a plain deny reads like a revocation that never happened.

`grpc_code` carries the gRPC status the call ended on, lower-underscore as gRPC
names them (`ok`, `unauthenticated`, `permission_denied`, `unavailable`,
`deadline_exceeded`, `internal`). It is present whenever the call was
**attempted** and absent on the decisions that never reach the wire, and it
**replaces** `http_status` outright rather than sitting beside it. `reason` is
kept for the causes a status cannot express: `bad_body`, `token_mint_failed`,
`rest_url_configured`.

`openfga_code` carries OpenFGA's **own** error number when it sent one — see
the next section. It sits beside `grpc_code` rather than replacing it because
they answer different questions: `grpc_code` is what the transport concluded,
and therefore what the mesh, the proxy and any hop telemetry recorded (always
`internal` for these), while `openfga_code` is what the service actually said
and is the only one that can be looked up.

One distinction is genuinely lost and is better said than hidden: over HTTP a
refused connection had no status and a served error had one, so `transport` and
`http_error` could be told apart. gRPC gives a refused connection and a server
answering "I am unavailable" the same code, and no part of the protocol
separates them, so the record says `unavailable` and does not guess.

**Why it exists here and not in OpenFGA.** OpenFGA logs no authenticated
subject, and the multicluster gateway collapses every caller into one mesh
identity before the request arrives. The decision is per-caller; the record was
not. This is the only place it can be written.

**Why the subject is on it.** The estate's telemetry rule keeps `sub` off spans.
That rule and this line are both right, because they are about different sinks:
the line goes to the application log, behind the same boundary as the process,
and never onto a span. Without the subject the record answers nothing. A subject
that failed the uuid rule is recorded as `(invalid)` rather than verbatim — that
value came from the host and could be an email.

`src/entitlements` is a portable directory, so it cannot import this app's
logger; it exposes a sink and `registerConnect` installs `app.log.info` into it.
Unset, it falls back to the console rather than dropping the trail.

### Fail-closed on the Check

Any answer that is not an explicit `allowed: true` is a deny, and a failure is
an **error**-deny rather than a revocation.

Under HTTP this rule was inherited: the Check was `axios.post` with no
`validateStatus`, and axios's default rejects anything outside 2xx, which is
what turned a sidecar's fast 504 during a partition into a deny. gRPC has
nothing to inherit — a unary call either resolves with a message or throws a
`ConnectError` carrying a `Code` — so the rule is now written out in full, and
written as a **total** one: the only path that returns a grant is the one that
received `allowed === true`, and the catch enumerates no codes at all.
Enumerating them is how the class nobody thought of becomes the class that
fails open.

`test/entitlements/fail-closed.test.ts` pins it so it cannot pass for the wrong
reason: the fake grants every Check it is not told to refuse, so a mutation that
treated an unreachable OpenFGA as a pass turns the suite red — measured, seven
cases including one that minted a signed assertion for a service that was never
reached. Source assertions sit beside it, because behaviour alone cannot catch
the transport quietly coming back: `grants.ts` is asserted to contain no
`axios`, no `maxRedirects`, no `validateStatus`, and exactly one named gRPC code
(`Unauthenticated`, in the retry branch).

`test/entitlements/wire-surprise.test.ts` is the successor to the redirect
finding. gRPC has no redirects, so the specific trap is gone, but the reasoning
that found it was not about redirects — it was that the rule had been verified
against the failures someone thought to list. The question is re-asked on a raw
h2c socket: a middlebox answering 301/302/303/307/308 (denies, and the target
records no request), an ingress answering HTML or the old REST JSON with a 200
(`unknown`), and correct framing carrying bytes that are not a `CheckResponse`
(`internal`).

### Edge authentication (OIDC + DPoP)

Four variables are **required and have no default**. The process refuses to
start without them, which is deliberate: every plausible default is wrong in a
way that only shows up as an accepted token that should have been refused.

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_ISSUER` | **required** | Authentik issuer, pinned on every access token |
| `OIDC_AUDIENCE` | **required** | audience, pinned on every access token |
| `OIDC_JWKS_URI` | **required** | JWKS endpoint; must be `https` unless it is loopback |
| `COORDINATOR_PUBLIC_ORIGIN` | **required** | the origin every DPoP `htu` is compared against — never the `Host` header, which the caller controls |
| `OIDC_ALGORITHMS` | `RS256,ES256,PS256` | accepted access-token algorithms |
| `DPOP_ALGORITHMS` | `ES256,ES384,PS256,RS256` | accepted proof algorithms; symmetric and `none` are refused at startup |
| `DPOP_PROOF_MAX_AGE_SECONDS` | `30` | how old a proof's `iat` may be |
| `DPOP_CLOCK_SKEW_SECONDS` | `5` | how far into the future a proof's `iat` may be |
| `DPOP_NONCE_PERIOD_SECONDS` | `300` | nonce bucket rotation; the current and previous bucket are accepted |
| `DPOP_JTI_MAX_ENTRIES` | `100000` | hard cap on the in-memory replay window |
| `DPOP_REQUIRE_NONCE` | `true` | whether a proof must carry a nonce |
| `DEVICE_CACHE_TTL_SECONDS` | `5` | in-process cache of the device binding |

The `jti` replay window's TTL is **derived**, not configured: it is always
`DPOP_PROOF_MAX_AGE_SECONDS + DPOP_CLOCK_SKEW_SECONDS`. Letting an operator set
it independently invites a configuration where an evicted `jti` still names a
proof the `iat` check would accept.

**Routes.** `POST /auth/devices` enrols the key that signed the proof (first
sign-in) and is idempotent; `POST /auth/devices/:deviceId/revoke` sets
`revoked_at` and never deletes; `GET /auth/session` returns the verified
identity. Any other route opts in with `{ preHandler: app.dpopGuard }`, after
which `request.identity` carries `{ userId, deviceId, jkt }`.

**The `use_dpop_nonce` round trip.** Every guarded response carries a fresh
`DPoP-Nonce`, success or failure. A client with no nonce gets one `401` with
`WWW-Authenticate: DPoP error="use_dpop_nonce"` and retries the same request
once with the supplied nonce **and a fresh `jti`**. A client that refreshes the
nonce from every response never sees that 401 again, including across a bucket
roll. A coordinator restart invalidates every outstanding nonce by design — that
is what makes the empty replay cache after a restart unexploitable — so each
client pays exactly one extra round trip.

The port follows the estate scheme: the middle digit encodes the stage, so
test, dev and local-container are `5072`, `5092` and `5082`.

`OTEL_TRACES_EXPORTER=none` is **removed from the environment at startup**, by
design. It makes the SDK register a no-op provider whose trace id is all zeroes,
and fc-shared treats an all-zero id as "no span" — so every log line would
silently lose its trace tag. With no collector configured the service uses a
real span processor and a no-op *exporter* instead, which keeps trace ids real.

### Trace propagation (§A.5 rule 3) — complete

Rule 3 is done end to end, and it took both slice-1b branches to close it. Each
half was the other's "still open".

**Inbound HTTP** (`src/platform/http-trace.ts`). An `onRequest` hook opens a
`SERVER` span from the incoming `traceparent` and keeps it active for the whole
request, so every log line a handler emits carries `trace=<id> span=<id>` joined
to the caller's trace. Spans are named by route TEMPLATE, never by concrete
path, and `/healthz` opens no span at all — a liveness probe every second is
noise, not a trace.

**Connect** (`src/connect/interceptors.ts`). The server interceptor continues
the caller's trace into the RPC handler; the client interceptor opens a `CLIENT`
span and injects `traceparent` on the outbound SpineRead hop. Both are on by
default — `SpineReadClient` attaches the client one unless a caller replaces the
list, so the mesh hop cannot be left untraced by forgetting to wire it.

The result is one `traceparent` threading fc-mobile, this service and the spine,
with the coordinator visible in the middle as its own span rather than as a
transparent relay.

Spans record **outcome and counts only** — the rpc name and, on failure, the
Connect status code. Never a subject, never the assertion, never a proof, never
a nonce. `recordException` is deliberately not called: it would copy an upstream
error message onto the span, and a `ConnectError`'s message routinely carries
whatever the upstream said.

## Health

`GET /healthz` returns 200 when the database answers and 503 when it does not.

```json
{
  "status": "ok",
  "service": "fc-coordinator",
  "version": "0.1.0",
  "db": { "reachable": true, "latencyMs": 1.4, "target": "pg-coord-rw.fc:5432/fccoord" },
  "otel": { "registered": true, "exporter": "otlp" }
}
```

The body never carries a credential: the target is stripped of its userinfo, and
a database failure is reported as the driver's error **code**, never its message
(a `pg` connection error routinely echoes the DSN).

## Test

```
npm test              # vitest run
npm run test:coverage # vitest run --coverage, gated at 85% line AND branch
```

The coverage gate lives in `vitest.config.ts`, so it fails locally on the same
thresholds CI uses. The migration suite starts a real `postgres:17-alpine`
through Testcontainers, creates a non-superuser migrator role, and runs the
actual `scripts/migrate.sh` against it. Docker must be running.

## Migrate

```
PGHOST=... PGUSER=<migrator> PGPASSWORD=... PGDATABASE=fccoord \
  npm run migrate
```

Numbered raw SQL plus `psql`, mirroring fc-aggregation's proven doctrine:

- each file commits **atomically with its ledger row** (`psql -1`), so a crash
  can never leave an applied-but-unrecorded migration;
- applied files are **immutable** — an edited file refuses the whole run;
- a back-dated numeric prefix refuses the whole run (fix forward, gaps are fine);
- transaction control inside a migration refuses the whole run: the runner owns
  the boundaries;
- it refuses to run as a **superuser** and refuses the maintenance databases;
- re-running is a no-op.

Exit codes: `0` success, `2` preflight refusal, `4` provenance refusal, `5`
transaction control in a pending file, `6` out-of-order file.

| Migration | Contents |
|---|---|
| `0001_identity.sql` | `app_user` (id **is** the Authentik uuid), `device` (DPoP `jkt` + public JWK, revoke-never-delete) |
| `0002_collection.sql` | `collection`, `holding` — the HOLDING layer; spine references are TEXT, never foreign keys |

## Shared baseline

`src/platform/shared.ts` is the **only** module that names
`@figurecollecting/fc-shared`, enforced by a test. It re-exports the trace,
redaction and logging surface and deliberately omits the legacy axios client,
fc-mobile's zustand stores and the Mongo-shaped `Figure`/`User` types.

It imports the **1.7.0 stateless subpaths** (`utils/trace`, `utils/sanitize`,
`utils/logger`), never the barrel. The barrel is a single bundle that also holds
the axios client for legacy fc-backend and fc-mobile's zustand stores, so taking
`getTraceContext` from it would load axios, zustand and react into a
Postgres-only service. `test/import-graph.test.ts` measures the real module
graph of the built output in a child process, using Node's own resolver, and
fails if any of the three is ever resolved again.

Those three packages are still **installed** — they remain fc-shared's declared
dependencies, so `npm ci` fetches them and they sit in the runtime image. What
1.7.0 buys is that nothing ever *loads* them. Removing them from the tree would
need fc-shared to make them optional or peer dependencies, which is a change to
that package, not to this one.

`tsconfig.json` `extends` the shipped `@figurecollecting/fc-shared/tsconfig.base.json`,
so the toolchain baseline is inherited mechanically rather than by convention.
**One field is overridden**: the base ships `module: ESNext` with
`moduleResolution: bundler`, which suits a library bundled by esbuild for
browsers. This is a Node ESM service run straight from `dist/`, so it uses
`nodenext` for both — `bundler` would type-check imports that Node then fails to
resolve at runtime. Everything else (target, strict, `esModuleInterop`,
`skipLibCheck`, `forceConsistentCasingInFileNames`) comes from the base.

## CI

The fork shift-left policy: fork **feature** branches run the full core CI, fork
`develop`/`main` mirrors run nothing, and the image build is org-only. A fork
run authenticates to GitHub Packages with a fork-held `read:packages` PAT in
`secrets.NODE_AUTH_TOKEN`; the org falls back to `GITHUB_TOKEN`.

### The image

`ghcr.io/figurecollecting/fc-coordinator`, built by the `Build container image`
job and pushed by a separate `Publish container image` job on **org push events
only**, meaning the two integration branches and a `v*` tag. A pull_request
reaches the build job and not the publish job, so it never logs in to the
registry, and a fork never publishes at all.

**Why two jobs.** GitHub's `permissions:` takes no expression, so one job cannot
hold `packages: write` on a push and `packages: read` on a pull_request. Keeping
the push in its own job is the only way the write scope is absent from the runs
that can never use it. `Build container image` therefore holds `packages: read`
and is the required check; `Publish container image` holds the write scope and
runs on push alone.

Tags: the branch name, the release tag when there is one, and `sha-<short>` on
every publish. The publish job emits the **digest** as a job output and into the
run summary, because fc-infra pins the image by digest rather than by tag, so a
manifest cannot silently follow a retag.

**The non-root assertion is made twice, against two different things.** The
build job asserts it against its own `load: true` output, which is the
pull_request gate. The publish job then **pulls the pushed digest back and
asserts it again**, because the publish is a second buildx invocation and the
claim that it is byte-identical rests on the GHA cache hitting. It normally
will; an eviction, a concurrent run or a failed cache write is enough for it not
to, and an assertion about the published artifact has to be made about the
published artifact.

The package inherits the org's no-public-packages policy, so it is private like
scraper's and ingest-server's. The cluster pulls it with the `ghcr-pull`
`imagePullSecret`, which must exist in the target namespace before the first
rollout.

## `coordinator.v1` — the Compare pass-through

`POST /coordinator.v1.CompareService/Compare`, Connect protocol over plain
HTTP — Connect-Web, so fc-mobile needs no gRPC-Web proxy and this service needs
no second listener. The contract is `@figurecollecting/fc-api-contract`.

```
curl -X POST http://127.0.0.1:5052/coordinator.v1.CompareService/Compare \
  -H 'Content-Type: application/json' \
  -H 'Connect-Protocol-Version: 1' \
  -d '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}'
```

**What the coordinator adds**: authentication (the edge), authorisation (an
OpenFGA Check, then a 60-second Ed25519 assertion minted server-side and
attached to the mesh hop as the `fc-entitlements` header), and nothing else.
The assertion never reaches the client.

**What it never does**: reinterpret the spine's answer. `result_json` crosses
back **byte for byte** — never parsed and reserialised, because read.v1's
fidelity doctrine keeps every scraped token as raw text and a JSON round trip
would undo that at the last hop. `coverage` is a **lift**: the same members of
`redacted` in the same order, and the same `semanticsRev` string, copied out of
`result_json` so a client can decide whether to render an "unavailable to you"
affordance without parsing the blob.

A response whose coverage cannot be lifted is refused with `INTERNAL`, not
returned with an empty `redacted`. Claiming "nothing was withheld" about a
response nobody could read is the confident zero the redaction contract exists
to prevent.

| Case | Answer |
|---|---|
| entitled | `200`, `stockOnHand` present, `coverage.redacted: []` |
| not entitled | `200`, `stockOnHand` absent, `coverage.redacted: ["inventory_levels"]` |
| OpenFGA unconfigured or unreachable | as "not entitled" — **fail closed**, and the correct state until plan decision D4 lands |
| no signing key | as "not entitled" |
| nobody authenticated | as "not entitled" — rejecting is the edge plugin's job, not this handler's |
| neither seed set, or a `now_iso` with no time or no zone | `INVALID_ARGUMENT`, before any mesh call |
| unknown seed | `200` with `heads: []` — not an error |
| spine unconfigured or unreachable | `UNAVAILABLE` |

### Guarded, and how that is known

Compare declares **no `config.auth`**, so the edge's deny-by-default registry
classifies it `guarded`. Absence is the protection — there is no per-route opt-in
to forget. `connect-fastify` registers the RPC as ONE route entry covering nine
methods (`GET HEAD TRACE DELETE OPTIONS PATCH PUT QUERY POST`), and
`test/connect/guarded.test.ts` asserts all nine reject an uncredentialed call and
that neither the spine nor OpenFGA is reached on the way to the refusal. A guard
that only covered POST would leave eight verbs open on an authenticated route
while a URL-only enumeration test still passed.

The same file drives the whole path: enrol a device, then a Connect unary POST
carrying an access token and a DPoP proof, and asserts that **the uuid the proof
was verified for is the uuid OpenFGA was asked about**. That is the first
assertion in which the identity a caller proved and the identity the spine is
told about are the same value, established by two independently built modules.

### The identity seam

The handler needs one thing from authentication: the caller's Authentik uuid.
`CALLER_IDENTITY_DECORATOR` and `CallerIdentity` are declared once in
`src/identity.ts` and imported by both the edge and this module — they used to be
a string literal on each branch, and a mismatch would have been silent and
safe-looking (every caller reads as unauthenticated, every Compare redacted, both
suites green).

`src/connect/identity.ts` keeps the part that is genuinely this side's: turning a
Fastify request into a Connect handler-context value, and an **injected resolver**
so a test can supply an identity without standing up the edge. A resolver that
finds nothing returns `null`, and `null` means no entitlement — a successful,
redacted Compare. Rejecting an unauthenticated caller belongs to the edge,
upstream; if both layers rejected, one rule would have two owners.

### The issuer pin — a two-sided deploy, and a silent failure if you get it wrong

fc-aggregation's verifier **pins `iss`** to a single expected value and rejects
anything else the way it rejects everything else: empty grants, normal 200, no
error and nothing in the spine's logs. A coordinator minting under an issuer the
deployed verifier does not accept therefore looks *exactly* like a coordinator
whose users simply have no grants.

That is fail-closed, which is the right direction, but it is the kind of
fail-closed that can sit in production for weeks looking like a product
decision. So:

- `ENTITLEMENT_SIGNING_ISSUER` **defaults to the contract's `ENTITLEMENT_ISSUER`**,
  which is what the deployed verifier expects today. Out of the box the entitled
  path works and nothing changes.
- Setting it to anything else logs **one warning** naming both the value and the
  consequence, because "reads come back redacted" is the symptom an operator
  will actually be chasing.
- The boot line reports the live value (`iss=…`), so the deployed setting is
  observable without reading a Secret.
- **Order of operations, if the coordinator is ever to stop claiming to be
  fc-backend**: teach ingest-server's verifier the new issuer (or a list),
  deploy that, and only then set this variable. The reverse order redacts
  everything with no signal.
- **In production this is set explicitly to `fc-coordinator`**, and the code
  default deliberately stays the contract's. The spine already accepts
  `fc-backend,fc-coordinator`, so the first half of that order is done and the
  variable can be set today. Setting it in the manifest rather than changing the
  default is what **decouples** the later narrowing: once ingest-server drops
  `fc-backend` from its accepted issuers, nothing here has to change in step. A
  coordinator relying on the default would have minted under `fc-backend` and
  redacted every read from that moment, with a healthy boot line, OpenFGA
  allowing, and the spine saying `wrong_issuer` into the void.

`test/connect/compare.test.ts` pins the failure end to end: with OpenFGA
allowing, a good key, a real uuid and a valid signature, a mismatched issuer
still comes back with `coverage.redacted: ["inventory_levels"]`, and the answer
is byte-for-byte identical to an ordinary denial.

### The ported entitlement module

`src/entitlements/` is a **directory copy** of fc-backend's U6 module (PR #249,
merged at `c82fb05`), whose review defects were already fixed on that head: the
uuid guard now bites in both the Check and the mint, the portability test catches
bare and dynamic imports, `timeout: 0` falls back to the default, and the grant
cache is bounded. The port changed ESM import specifiers and the header comment;
`entitlementSubject.legacy.ts` and the `authentikId` model field were **not**
carried across — the subject comes straight from the identity resolver.

It imports node builtins, `axios` (the OIDC token mint), `@connectrpc/connect`,
`@connectrpc/connect-node` and `@bufbuild/protobuf` (the OpenFGA Check, which is
gRPC), `@figurecollecting/ingest-contract`, and its own generated wire types
under `gen/` — and nothing else, in particular not this app's logger, which is
why it writes to `console`.

Connect was **admitted** to that set rather than hidden behind an injected seam,
and the argument is in the guard's own header. In short: this module's entire
claim is that an answer which is not an explicit `allowed: true` is a deny, and
over gRPC that rule is stated in the transport's vocabulary — the mapping from
`Code` to error-deny **is** the fail-closed guarantee. Behind a seam that
mapping moves into the host, every future host re-implements the one rule the
directory exists to guarantee, and the suite that proves it can no longer prove
it about anything real. The line was never "no transport" (the token mint has
always been axios); it is "no host coupling", and the relative-path rule still
enforces that absolutely. If this module were published outside the estate the
seam would win instead.

`test/entitlements/portability.test.ts` fails the build if that stops being true
— it walks the directory recursively, so the generated types are held to the
same rule, and it forbids Connect's **server** symbols outright because the
module is a client. `test/import-graph.test.ts` asserts the built graph resolves
`axios` **only** from inside `dist/entitlements/`, never as a transitive of the
fc-shared barrel, and that the gRPC client and the generated descriptor really
are in the emitted output.
