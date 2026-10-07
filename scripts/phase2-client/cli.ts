// `npm run phase2 -- ...`: argv in, exit code out. Everything else is in main.ts.
import { liveDeps, main } from './main.js';

process.exitCode = await main(process.argv.slice(2), liveDeps());
