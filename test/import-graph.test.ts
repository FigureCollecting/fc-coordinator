// ============================================================================
// Graph purity: what the coordinator's runtime actually loads.
//
// fc-shared 1.7.0 exists so a Node service can take `getTraceContext` without
// dragging in axios, zustand and react — the browser half of the package. A
// test that only checked "the import works" would pass on the 1.6.0 barrel too,
// so this one measures the REAL module graph of the REAL built output, in a
// child process, using Node's own resolver.
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

// The browser half of fc-shared. None of it belongs in a Postgres-only service:
// api/* is the axios client for LEGACY fc-backend, stores/* are fc-mobile's
// zustand singletons, and react arrives only as zustand's peer.
const FORBIDDEN = ['axios', 'zustand', 'react'];

interface Graph {
  resolved: string[];
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

function hits(graph: Graph, forbidden: string): string[] {
  const bySpecifier = graph.resolved.filter(
    (specifier) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
  const byPath = graph.required.filter((file) => file.includes(`/node_modules/${forbidden}/`));
  return [...bySpecifier, ...byPath];
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
    const graph = probe(BUILT_SEAM);
    for (const forbidden of FORBIDDEN) {
      expect({ forbidden, hits: hits(graph, forbidden) }).toEqual({ forbidden, hits: [] });
    }
  });

  it('loads the whole application without resolving axios, zustand or react', () => {
    const graph = probe(BUILT_APP);
    for (const forbidden of FORBIDDEN) {
      expect({ forbidden, hits: hits(graph, forbidden) }).toEqual({ forbidden, hits: [] });
    }
  });

  it('still reaches the fc-shared values the coordinator depends on', () => {
    // Guard against a vacuous pass: a graph that loads NOTHING would also have
    // no forbidden hits. Prove the real package is in there.
    const graph = probe(BUILT_SEAM);
    const reachesShared = [...graph.resolved, ...graph.required].some((entry) =>
      entry.includes('@figurecollecting/fc-shared'),
    );
    expect(reachesShared).toBe(true);
  });
});
