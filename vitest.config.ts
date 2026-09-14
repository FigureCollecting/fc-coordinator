import { defineConfig } from 'vitest/config';

// Coverage gate is enforced HERE, not only in CI: `npm run test:coverage`
// fails locally on the same thresholds the workflow uses, so a red bar is
// found before the push rather than after it (estate standard: 85% line AND
// branch on affected code).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Testcontainers pulls and boots a real postgres:17 image on first run.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // server.ts is the process entrypoint: listen/SIGTERM wiring with no
        // logic of its own. It is exercised by the image healthcheck, not by
        // a unit test that would have to bind a port to prove `listen` works.
        'src/server.ts',
      ],
      thresholds: {
        // PER FILE, not a repo-wide average. The estate standard is 85% on
        // AFFECTED code; a global threshold lets an entirely untested file ship
        // behind well-covered neighbours, and hands out more slack the bigger
        // the repo gets. test/coverage-gate.test.ts proves this bites.
        perFile: true,
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
