// ============================================================================
// The coverage gate must enforce the estate standard, which is 85% on AFFECTED
// code — not 85% averaged across the repo. A global-only threshold lets an
// entirely untested file ship as long as its neighbours are good enough, and
// the bigger the codebase grows the more slack it hands out.
//
// Two assertions, deliberately different in kind:
//   1. BEHAVIOURAL — run a child vitest with one untested file added to the
//      coverage set and prove the gate fails AND names that file, while the
//      GLOBAL numbers are still comfortably above 85. If the failure were
//      global, the global numbers would be the ones below threshold.
//   2. STATIC — assert the config still declares perFile. The behavioural case
//      alone cannot catch its removal in every arrangement; this can.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = 'test/fixtures/coverage-gate-probe.ts';

interface Thresholds {
  perFile?: boolean;
  lines?: number;
  branches?: number;
  functions?: number;
  statements?: number;
}

describe('the coverage gate is per file, not a repo-wide average', () => {
  it('fails and names an untested file even when the global numbers pass', () => {
    // The child MUST write its coverage somewhere else. Sharing the parent's
    // reportsDirectory makes the child wipe coverage/.tmp mid-run and the
    // parent dies with "Something removed the coverage directory".
    const reports = mkdtempSync(path.join(tmpdir(), 'fc-coordinator-gate-'));
    let output: string;
    let status: number | null;
    try {
      // The positional filter is `src/`, so the child runs only the src suites —
      // this file lives under test/, so there is no recursion.
      const run = spawnSync(
        'npx',
        [
          'vitest',
          'run',
          '--coverage',
          '--coverage.include=src/**/*.ts',
          `--coverage.include=${PROBE}`,
          '--coverage.reporter=text',
          `--coverage.reportsDirectory=${reports}`,
          'src/',
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 300_000 },
      );
      output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      status = run.status;
    } finally {
      rmSync(reports, { recursive: true, force: true });
    }
    const run = { status };

    expect(run.status).not.toBe(0);
    expect(output).toContain('coverage-gate-probe.ts');
    expect(output).toMatch(/threshold/i);

    // Prove it was the PER-FILE rule that bit, by reading the threshold
    // failures themselves rather than the summary table — which vitest prints
    // on a TTY but not in CI, so parsing it made this test pass locally and
    // fail on the runner.
    //
    // A per-file failure ends with "for <path>"; a repo-wide failure carries no
    // such suffix. So: at least one failure, and EVERY failure names the probe.
    // The absence of an unsuffixed line is the proof that the global numbers
    // were fine and only the per-file rule objected.
    const failures = output.split('\n').filter((line) => line.includes('does not meet'));
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) {
      expect({ line: line.trim(), namesProbe: line.trimEnd().endsWith(PROBE) }).toEqual({
        line: line.trim(),
        namesProbe: true,
      });
    }
  }, 300_000);

  it('declares perFile and the estate thresholds in the config', () => {
    const thresholds = config.test?.coverage?.thresholds as Thresholds | undefined;
    expect(thresholds?.perFile).toBe(true);
    expect(thresholds?.lines).toBe(85);
    expect(thresholds?.branches).toBe(85);
    expect(thresholds?.functions).toBe(85);
    expect(thresholds?.statements).toBe(85);
  });
});
