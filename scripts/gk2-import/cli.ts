// `npm run gk2-import -- ...`: argv in, exit code out. Every decision is in main.ts, which is covered.
import { readFile, writeFile } from 'node:fs/promises';
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  readFile: (path) => readFile(path, 'utf8'),
  // The writes are a person's private list: owner-only.
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  now: () => new Date(),
});
