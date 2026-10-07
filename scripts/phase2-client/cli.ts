// WK-11 skeleton: the behaviour lands in the next commit.
import { liveDeps, main } from './main.js';
process.exitCode = await main(process.argv.slice(2), liveDeps());
