/**
 * THE PORTABILITY GUARD.
 *
 * src/entitlements is meant to be a directory copy away from running in its
 * next host — it already made one such trip, out of fc-backend and into this
 * service. That is a claim about its IMPORTS, and a claim about imports rots
 * the moment someone reaches for a convenience: the app's logger, a config
 * helper, the Fastify request, a pg pool "just for the subject". Each of those
 * is one line to write and a rewrite to undo later, so the constraint is
 * asserted mechanically here rather than left in a comment nobody reads.
 *
 * WHAT IS ALLOWED: node builtins, `axios`, `@figurecollecting/ingest-contract`,
 * and files within this directory. Nothing else, and nothing reached by
 * climbing out of the directory with `../`.
 *
 * If a genuinely new dependency belongs in the module, add it to ALLOWED_BARE
 * deliberately — and know that it becomes a dependency of every future host.
 *
 * Ported from fc-backend tests/services/entitlements/portability.test.ts (the
 * D2-fixed version, which already understands bare side-effect and dynamic
 * imports). The port changes `__dirname` to `import.meta.dirname`, adds the
 * `.js` specifier that ESM resolution requires, and adds two guards this host
 * needs: its own coupling temptations in the forbidden-symbol pass, and a rule
 * that the portable directory carries no test file of its own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE_DIR = path.resolve(import.meta.dirname, '../../src/entitlements');

const ALLOWED_BARE = [/^node:/, /^axios$/, /^@figurecollecting\/ingest-contract(\/|$)/];

/**
 * Every module specifier in a source file, in EVERY form the language offers.
 *
 * The forms matter more than they look. A guard that only understands
 * `from '...'` is satisfied by `import '../platform/logger.js'` and by
 * `() => import('../db/pool.js')` — both real coupling, both invisible, and
 * neither caught by the forbidden-symbol pass if the module has a neutral
 * name. A partial guard is worse than none, because it is believed.
 */
export const specifiersIn = (source: string): string[] => [
  // import x from 'm' / import {a} from 'm' / import * as m from 'm' / export {a} from 'm'
  ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
  // import 'm'  — side-effect only, no bindings, no `from`
  ...[...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
  // import('m') — dynamic, deferred, and just as much a dependency
  ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
  // require('m')
  ...[...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
];

const allFiles = fs.readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'));
const moduleFiles = allFiles.map((name) => path.join(MODULE_DIR, name));

describe('the specifier extractor sees every import form', () => {
  // Tested on SOURCE STRINGS rather than on the real files, because the whole
  // point is the forms the real files do not currently contain.
  it.each([
    ['static default', "import axios from 'axios';", 'axios'],
    ['static named', "import { Pool } from 'pg';", 'pg'],
    ['namespace', "import * as m from 'pg';", 'pg'],
    ['re-export', "export { grantsForSubject } from './grants.js';", './grants.js'],
    ['bare side-effect', "import '../platform/telemetry.js';", '../platform/telemetry.js'],
    ['dynamic', "const later = () => import('../platform/logger.js');", '../platform/logger.js'],
    ['dynamic, awaited', "const l = await import('../platform/logger.js');", '../platform/logger.js'],
    ['require', "const m = require('pg');", 'pg'],
  ])('catches a %s import', (_label, source, expected) => {
    expect(specifiersIn(source)).toContain(expected);
  });
});

describe('src/entitlements is self-contained', () => {
  it('contains the module (guards against a rename silently emptying this suite)', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('carries no test file of its own — a portable directory brings no host harness', () => {
    // A *.test.ts here would import vitest, which is not on the allowlist, so
    // the case below would fail with a confusing "unexpected bare import".
    // Said plainly instead: the tests for this module live in test/, exactly so
    // the directory copies without them.
    expect(allFiles.filter((name) => name.includes('.test.'))).toEqual([]);
  });

  it.each(moduleFiles.map((f) => [path.basename(f), f]))(
    '%s imports nothing outside the module',
    (_name, file) => {
      const source = fs.readFileSync(file, 'utf8');
      for (const spec of specifiersIn(source)) {
        if (spec.startsWith('.')) {
          // A relative import must stay inside this directory.
          const resolved = path.resolve(path.dirname(file), spec);
          expect(resolved.startsWith(MODULE_DIR + path.sep) || resolved === MODULE_DIR).toBe(true);
          continue;
        }
        expect(ALLOWED_BARE.some((re) => re.test(spec))).toBe(true);
      }
    },
  );

  it.each(moduleFiles.map((f) => [path.basename(f), f]))(
    '%s names no database, ORM, framework or app-model symbol in CODE',
    (_name, file) => {
      // Comments are stripped first, deliberately: these files are SUPPOSED to
      // talk about what porting them means, and index.ts names the legacy glue
      // it replaced. A prose mention is documentation; a live reference is the
      // coupling this guard exists to catch.
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const forbidden of [
        // carried over from fc-backend — the host it left
        /\bmongoose\b/i,
        /\bmongodb\b/i,
        /models\/User/,
        /\bSequelize\b/,
        /\bprisma\b/i,
        /\bTypeORM\b/i,
        /\bknex\b/i,
        // this host's own temptations
        /@figurecollecting\/fc-shared/,
        /\bfastify\b/i,
        /\bconnectrpc\b/i,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    },
  );
});
