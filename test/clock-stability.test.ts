// ============================================================================
// THE WALL CLOCK IS NOT A FIXTURE, and this suite keeps it that way.
//
// Three members of one family have now been found. Commit fef12ca fixed an
// elapsed-time assertion in grants.test.ts that read Date.now() twice; a later
// review found the same shape in dpop.test.ts, where a proof is dated a fixed
// number of seconds either side of one clock read and judged against another;
// and the sweep for that found a third in fail-closed.test.ts. Each fails once
// in a few hundred runs, which is precisely what makes them expensive: the
// reproduction attempt succeeds at proving nothing, and so does the fix.
//
// So the property is asserted mechanically instead. A test that does not read
// the wall clock twice for one assertion cannot care what the wall clock does
// between two reads — so a child vitest is run with a Date.now() that drifts a
// second on EVERY read, in both directions, and the listed files must be green
// under both. Under the drift they were red: forward broke the future-skew and
// the inside-the-allowance cases, backward broke the stale-proof and the
// elapsed-time ones.
//
// WHAT BELONGS ON THIS LIST: a file whose time-dependent behaviour is driven
// through an injected clock. NOT every test file. src/auth/plugin.test.ts is
// an acceptance test over the assembled edge, whose runtime takes no clock by
// deliberate design (see registerAuth) and whose access tokens are minted
// against the real one, so it cannot be green under a drifting clock and
// listing it would assert something untrue. Its one two-read site carries a
// 300-second margin and says so where it sits.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A child's output, with terminal colour removed.
 *
 * Both assertions below read a child process's stdout, and a child decides for
 * itself whether to colour it. On a developer's machine, piped into a buffer,
 * it does not; on the GitHub runner it does, and `1000` arrives as
 * `\u001b[33m1000\u001b[39m`. That turned a passing child into a failing
 * assertion here — the guard reporting red for a reason that had nothing to do
 * with the property it guards, which is the mirror image of the fault it exists
 * to prevent. The children are asked not to colour AND the output is stripped,
 * because only the second of those is under this file's control.
 */
const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');

/** Child environment: no colour, plus whatever the case under test needs. */
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  ...extra,
});

/** Files that must not care what the wall clock does. See the header. */
const CLOCK_INDEPENDENT = ['src/auth/dpop.test.ts', 'test/entitlements/fail-closed.test.ts'];

describe('the suite does not read the wall clock twice for one assertion', () => {
  it.each(CLOCK_INDEPENDENT.map((f) => [f]))(
    '%s loads the stepping clock, so the child run below can bite it',
    (file) => {
      // WITHOUT THIS the guard has the one hole a mechanical guard must not
      // have. The child only drifts a file's clock if that file imports the
      // helper, so deleting the import would take the fix and the check out
      // together and leave a green bar behind. The import is the mechanism, so
      // it is asserted as well as used.
      const source = readFileSync(path.join(REPO, file), 'utf8');
      expect(source).toMatch(/import ['"][^'"]*helpers\/steppingClock\.js['"]/);
    },
  );

  it.each([
    ['forward — an ordinary tick, arriving with certainty', '1000'],
    ['backward — the non-monotonic step measured on this estate', '-1000'],
  ])(
    'passes with a clock that steps %s',
    (_label, step) => {
      const run = spawnSync('npx', ['vitest', 'run', ...CLOCK_INDEPENDENT, '--reporter=dot'], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 300_000,
        env: childEnv({ CLOCK_STEP_MS: step }),
      });
      const output = plain(`${run.stdout ?? ''}${run.stderr ?? ''}`);

      // The status alone would also be 0 if the child ran nothing at all, so
      // the count is asserted too — a filter typo must not read as a pass.
      expect({ status: run.status, output }).toMatchObject({ status: 0 });
      expect(output).toMatch(/Test Files\s+2 passed/);
    },
    300_000,
  );

  it('is actually stepping the clock, so a green child means something', () => {
    // The guard above is only worth having if the drift is real. A child that
    // silently failed to load the helper would be green for the wrong reason
    // and would go on being green after the fix was reverted, which is the one
    // failure mode a mechanical guard must not have. So the helper's own
    // arithmetic is measured: two consecutive reads, one step apart.
    const probe = (step: string): number => {
      const run = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          "await import('./test/helpers/steppingClock.ts'); const a = Date.now(); const b = Date.now(); console.log(b - a);",
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: childEnv({ CLOCK_STEP_MS: step }) },
      );
      // The LAST non-empty line, not the whole buffer: a runtime notice on
      // stdout would otherwise be parsed as the measurement and come back NaN.
      const lines = plain(run.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return Number(lines.at(-1));
    };

    // Two reads a second apart, in whichever direction was asked for...
    expect(probe('1000')).toBeGreaterThanOrEqual(1_000);
    expect(probe('-1000')).toBeLessThanOrEqual(-1_000);
    // ...and untouched when the variable is absent, which is how every other
    // run in this repo, and every run in CI, executes.
    expect(probe('0')).toBeLessThan(100);
  });
});
