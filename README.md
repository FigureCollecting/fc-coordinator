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
| `OPENFGA_API_URL` `OPENFGA_STORE_ID` | unset | the entitlement Check; **unset means every Check denies** |
| `OPENFGA_API_TOKEN` `OPENFGA_MODEL_ID` `OPENFGA_APP_OBJECT` `OPENFGA_TIMEOUT_MS` | unset / `app:figurecollecting` / `2000` | optional Check settings |
| `ENTITLEMENT_SIGNING_KEY_PEM` or `ENTITLEMENT_SIGNING_KEY_FILE` | unset | the Ed25519 PKCS#8 signing key; **unset means no assertion is ever sent** |
| `ENTITLEMENT_SIGNING_KID` | unset (derived from a key FILE's basename) | the JOSE `kid`; production mints under `ent-2026-09` or the spine silently redacts |
| `ENTITLEMENT_SIGNING_ISSUER` | the contract's `ENTITLEMENT_ISSUER` | the `iss` claim. **Do not set this until ingest-server's verifier has been taught the new value** — see below |
| `ENTITLEMENT_GRANT_CACHE_TTL_MS` `ENTITLEMENT_GRANT_ERROR_TTL_MS` `ENTITLEMENT_GRANT_CACHE_MAX` | `30000` / `5000` / `10000` | grant cache bounds; a value that is not a positive number falls back to the default |

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

It imports node builtins, `axios` and `@figurecollecting/ingest-contract` and
nothing else — not this app's logger, which is why it writes to `console`.
`test/entitlements/portability.test.ts` fails the build if that stops being
true, and `test/import-graph.test.ts` asserts the built graph resolves `axios`
**only** from inside `dist/entitlements/`, never as a transitive of the fc-shared
barrel.
