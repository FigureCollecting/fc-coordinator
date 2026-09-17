// ============================================================================
// Graph purity: what the coordinator's runtime actually loads.
//
// fc-shared 1.7.0 exists so a Node service can take `getTraceContext` without
// dragging in axios, zustand and react — the browser half of the package. A
// test that only checked "the import works" would pass on the 1.6.0 barrel too,
// so this one measures the REAL module graph of the REAL built output, in a
// child process, using Node's own resolver.
//
// SLICE 1b CHANGED WHAT "axios" MEANS HERE, and the guard had to get more
// precise rather than more permissive. The ported entitlement module
// (src/entitlements, the D6 U6 copy) declares axios as part of its portability
// contract, enforced by test/entitlements/portability.test.ts, and it is a
// direct dependency of this repo. So axios in the app graph is no longer
// evidence of anything by itself. What is still forbidden — and is the thing
// the original test was really about — is axios arriving as a TRANSITIVE of the
// fc-shared barrel. The distinction the graph can make is WHO ASKED, so that is
// what is asserted:
//
//   the fc-shared seam    resolves none of axios, zustand, react
//   the whole application resolves neither zustand nor react, and resolves
//                         axios ONLY from inside dist/entitlements/
//
// Loosening this to "axios is allowed anywhere" would have thrown away the
// original guard; the parent check keeps it and sharpens it.
//
// WHAT AXIOS IS STILL DOING IN THERE, after the OpenFGA Check became gRPC: the
// OIDC token mint (openfgaToken.ts). That hop goes to Authentik's token
// endpoint, which has no gRPC form and is on the estate's exemption list, so it
// stays HTTP and the assertion below stays anti-vacuous for a REASON rather
// than by luck. If that mint ever moves, the importer count drops to zero and
// this test goes red — which is the correct outcome, because at that point the
// dependency should leave package.json too.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(REPO, 'test', 'fixtures', 'import-graph-probe.mjs');
const BUILT_APP = path.join(REPO, 'dist', 'app.js');
const BUILT_SEAM = path.join(REPO, 'dist', 'platform', 'shared.js');

// The browser half of fc-shared, none of which belongs in a Postgres-only
// service: stores/* are fc-mobile's zustand singletons and react arrives only
// as zustand's peer. Forbidden outright, everywhere.
const BROWSER_ONLY = ['zustand', 'react'];

// Allowed, but only from the one directory whose contract declares it.
const ENTITLEMENTS_DIR = 'dist/entitlements/';

interface Resolution {
  specifier: string;
  parentURL: string | null;
}

interface Graph {
  resolved: Resolution[];
  required: string[];
}

function probe(target: string): Graph {
  const out = execFileSync(process.execPath, [PROBE, target], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return JSON.parse(out) as Graph;
}

/** Every resolution OF a package — by specifier, and by the file it landed in. */
function hits(graph: Graph, pkg: string): string[] {
  const bySpecifier = graph.resolved
    .filter((r) => r.specifier === pkg || r.specifier.startsWith(`${pkg}/`))
    .map((r) => r.specifier);
  const byPath = graph.required.filter((file) => file.includes(`/node_modules/${pkg}/`));
  return [...bySpecifier, ...byPath];
}

/** Who asked for a package, as repo-relative paths. */
function importersOf(graph: Graph, pkg: string): string[] {
  return graph.resolved
    .filter((r) => r.specifier === pkg || r.specifier.startsWith(`${pkg}/`))
    .map((r) => (r.parentURL === null ? '<entry>' : r.parentURL.replace(/^file:\/\//, '')))
    .map((file) => path.relative(REPO, file));
}

describe('the coordinator import graph never reaches the browser half of fc-shared', () => {
  beforeAll(() => {
    // Measure the real emitted output, which is what the image runs. Always
    // rebuild so a stale dist/ cannot make this pass on yesterday's imports.
    execFileSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
    expect(existsSync(BUILT_APP)).toBe(true);
    expect(existsSync(BUILT_SEAM)).toBe(true);
  }, 360_000);

  it('loads the fc-shared seam without resolving axios, zustand or react', () => {
    // The seam's rule is unchanged and absolute: nothing the coordinator takes
    // from fc-shared may pull the browser bundle, axios included.
    const graph = probe(BUILT_SEAM);
    for (const forbidden of ['axios', ...BROWSER_ONLY]) {
      expect({ forbidden, hits: hits(graph, forbidden) }).toEqual({ forbidden, hits: [] });
    }
  });

  it('loads the whole application without resolving zustand or react', () => {
    const graph = probe(BUILT_APP);
    for (const forbidden of BROWSER_ONLY) {
      expect({ forbidden, hits: hits(graph, forbidden) }).toEqual({ forbidden, hits: [] });
    }
  });

  it('resolves axios ONLY from the ported entitlement module, never from fc-shared', () => {
    const graph = probe(BUILT_APP);
    const importers = importersOf(graph, 'axios');

    // Anti-vacuous: the module really is in the graph and really does use it.
    expect(importers.length).toBeGreaterThan(0);
    for (const importer of importers) {
      expect({ importer, inEntitlements: importer.startsWith(ENTITLEMENTS_DIR) }).toEqual({
        importer,
        inEntitlements: true,
      });
    }
  });

  it('ships the gRPC client inside the entitlement module, not beside it', () => {
    // THE OTHER HALF OF THE SAME QUESTION. The Check is gRPC now, and a build
    // that emitted the module without its transport — tree-shaken, mis-pathed,
    // or left behind by a bad `clean` — would fail at the first read in
    // production and pass every unit test, which run the TypeScript rather than
    // dist/. So the real emitted graph is asked whether the client is in it,
    // and whether it is where the portability contract says it is.
    const graph = probe(BUILT_APP);
    const importers = importersOf(graph, '@connectrpc/connect-node');

    expect(importers.length).toBeGreaterThan(0);
    expect(importers.some((importer) => importer.startsWith(ENTITLEMENTS_DIR))).toBe(true);
  });

  it('carries the generated openfga wire types with the module', () => {
    // The descriptor is committed INSIDE src/entitlements (see buf.gen.yaml)
    // precisely so the directory travels whole. This proves the built output
    // agrees.
    const graph = probe(BUILT_APP);
    // A RELATIVE specifier, so it is matched on the resolution rather than on
    // the require cache: the emitted output is ESM and never goes through
    // require at all, which is why `required` is empty for it.
    const generated = graph.resolved.filter(
      (r) =>
        r.specifier.endsWith('gen/openfga/v1/openfga_service_pb.js') &&
        (r.parentURL ?? '').includes('/dist/entitlements/'),
    );
    expect(generated.length).toBeGreaterThan(0);
  });

  it('still reaches the fc-shared values the coordinator depends on', () => {
    // Guard against a vacuous pass: a graph that loads NOTHING would also have
    // no forbidden hits. Prove the real package is in there.
    const graph = probe(BUILT_SEAM);
    const reachesShared = [
      ...graph.resolved.map((r) => r.specifier),
      ...graph.required,
    ].some((entry) => entry.includes('@figurecollecting/fc-shared'));
    expect(reachesShared).toBe(true);
  });
});
