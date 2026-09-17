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
 * WHAT IS ALLOWED: node builtins, `axios`, `@connectrpc/connect`,
 * `@connectrpc/connect-node`, `@bufbuild/protobuf`,
 * `@figurecollecting/ingest-contract`, and files within this directory.
 * Nothing else, and nothing reached by climbing out of the directory with `../`.
 *
 * If a genuinely new dependency belongs in the module, add it to ALLOWED_BARE
 * deliberately — and know that it becomes a dependency of every future host.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY CONNECT AND PROTOBUF WERE ADMITTED, argued rather than assumed.
 *
 * The OpenFGA Check moved to gRPC, and there were two ways to keep this
 * directory honest about it: admit the client into the portable set, or hide
 * the transport behind an injected seam so the module named no client at all.
 * The seam is the more portable-LOOKING answer and it is the wrong one here.
 *
 * WHAT THE SEAM WOULD COST. This module's entire claim is one rule: an answer
 * that is not an explicit `allowed: true` is a deny. Over gRPC that rule is
 * stated in the transport's own vocabulary — every failure arrives as a
 * ConnectError carrying a Code, and the mapping from code to error-deny IS the
 * fail-closed guarantee. Put the client behind a seam and that mapping moves
 * into whatever host supplies the seam, so each future host re-implements the
 * one rule this directory exists to guarantee, and the suite that proves it
 * (test/entitlements/fail-closed.test.ts) can no longer prove it about anything
 * but a fake. A portability guard that preserved the shape while giving away
 * the property would be worse than none, because it would still be believed.
 *
 * WHAT ADMITTING THEM COSTS. Three packages, all already direct dependencies of
 * this repo, all already in its lockfile, and no new registry: the wire types
 * are generated in-repo under ./gen, not pulled from the buf registry.
 *
 * AND THE LINE WAS NEVER "NO TRANSPORT". The directory has always carried one —
 * openfgaToken.ts posts the client-credentials grant over axios, and still
 * does, because the OIDC token endpoint has no gRPC form. What the guard is
 * actually about is HOST coupling: the app's logger, its config, its Fastify
 * request, its pg pool. That rule is unchanged and the relative-path check
 * still enforces it absolutely.
 *
 * WHAT WOULD CHANGE THE ANSWER. If this module were published to consumers
 * outside the estate, the seam would win — an unknown consumer should not be
 * made to take a gRPC stack. Inside the estate the opposite holds: Ross's
 * 2026-09-17 ruling makes gRPC the wire for every component-to-component hop,
 * so a host that cannot take a Connect client cannot be a component in the
 * first place, and "portable" means portable to the hosts that exist.
 * ─────────────────────────────────────────────────────────────────────────────
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

const ALLOWED_BARE = [
  /^node:/,
  // The OIDC token mint, which is still HTTP because OIDC has no gRPC form.
  /^axios$/,
  // The OpenFGA Check, which is gRPC. See the header for the argument.
  /^@connectrpc\/connect$/,
  /^@connectrpc\/connect-node$/,
  /^@bufbuild\/protobuf(\/|$)/,
  /^@figurecollecting\/ingest-contract(\/|$)/,
];

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

/**
 * RECURSIVE, and it had to become so. The generated wire types live in
 * ./gen/openfga/v1/, and a guard that only read the top level would have let a
 * subdirectory import anything it liked — which is also the easiest way for a
 * future editor to get around this file without meaning to.
 */
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(dir, entry.name)]
          : [],
    );

const moduleFiles = walk(MODULE_DIR);
const allFiles = moduleFiles.map((file) => path.relative(MODULE_DIR, file));

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

  it.each(moduleFiles.map((f) => [path.relative(MODULE_DIR, f), f]))(
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

  it.each(moduleFiles.map((f) => [path.relative(MODULE_DIR, f), f]))(
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
        // Connect is admitted as a CLIENT and only as a client. These are the
        // server half, and one of them appearing here would mean the portable
        // module had started serving something — which is the host's job, in
        // src/connect, and a far bigger coupling than the logger this guard was
        // originally written to catch.
        /\bconnectNodeAdapter\b/,
        /\bfastifyConnectPlugin\b/,
        /\bConnectRouter\b/,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
    },
  );
});
