// Records what Node ACTUALLY loads when a module is imported.
//
// Run as a real child process so the measurement is Node's own resolver, not a
// bundler's guess or a reading of package.json. A resolve hook sees every
// specifier resolved transitively (ESM and, on Node >= 24, require too), and the
// CommonJS require cache catches anything that arrived through interop.
//
//   node test/fixtures/import-graph-probe.mjs <absolute module path>
//
// Prints one JSON object: { resolved: [{specifier, parentURL}], required: [] }.
//
// WHY THE PARENT IS RECORDED, not just the specifier. Slice 1b made `axios` a
// legitimate dependency of ONE directory — the ported entitlement module, whose
// portability contract names it explicitly — while it is still forbidden as a
// transitive of the fc-shared barrel. "Is axios in the graph" can no longer
// answer that; "who asked for axios" can.
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('usage: import-graph-probe.mjs <absolute module path>');
  process.exit(2);
}

const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    resolved.push({ specifier, parentURL: context.parentURL ?? null });
    return nextResolve(specifier, context);
  },
});

await import(pathToFileURL(target).href);

const require = createRequire(import.meta.url);
const required = Object.keys(require.cache);

console.log(JSON.stringify({ resolved, required }));
