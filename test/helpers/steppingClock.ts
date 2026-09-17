/**
 * AN ADVERSARIAL WALL CLOCK, for reproducing a flake instead of arguing about it.
 *
 * WHY THIS EXISTS. Commit fef12ca fixed one test that read `Date.now()` twice
 * and assumed the two reads were ordered; a later review found more members of
 * the same family. The trouble with the family is that each member fails once
 * in a few hundred runs, so "I could not reproduce it" is the expected outcome
 * of looking, and a fix that changes nothing looks exactly like a fix that
 * works.
 *
 * WHAT IT DOES. Loaded as a vitest `setupFiles` entry, it replaces `Date.now`
 * with one that drifts by CLOCK_STEP_MS on every read. The absolute value is
 * irrelevant: what breaks these assertions is the RELATIVE gap between the read
 * a fixture makes and the read the code under test makes a moment later, and a
 * per-read step makes that gap certain rather than rare.
 *
 *   CLOCK_STEP_MS=1000    every read is a second later than the one before —
 *                         an ordinary forward tick, arriving with certainty.
 *   CLOCK_STEP_MS=-1000   every read is a second EARLIER — the backwards step
 *                         measured on this estate's WSL2 hosts (a `-933` is
 *                         recorded in test/entitlements/grants.test.ts).
 *
 * HOW TO USE IT. The file under test imports this one for effect, so there is
 * nothing to wire up — vitest 4 has no `--setupFiles` flag and an earlier
 * version of this comment claimed one. Set the variable and run, against one
 * describe block at a time so the accumulated drift stays small enough not to
 * disturb anything with a genuinely wide margin:
 *
 *   CLOCK_STEP_MS=1000 npx vitest run src/auth/dpop.test.ts -t 'steps 3 and 4'
 *
 * To add a file to the regime, import this one at its top and list it in
 * test/clock-stability.test.ts, which asserts both.
 *
 * A test that passes under BOTH signs does not read the wall clock twice for
 * one assertion. That is the property this file exists to make checkable, and
 * it is not itself a test — nothing imports it and the suite never loads it.
 */
const step = Number(process.env['CLOCK_STEP_MS'] ?? '0');

if (Number.isFinite(step) && step !== 0) {
  const real = Date.now.bind(Date);
  let drift = 0;
  Date.now = (): number => {
    drift += step;
    return real() + drift;
  };
}
