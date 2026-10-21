// `npm run gk2-import -- --plan plan.json [--out writes.json]`: the import plan as the exact facet writes it would
// push, each one run through the coordinator's own Push validation. It sends NOTHING: no network, no sign-in. The
// plan and the writes are a person's private list: only counts, line names and facet keys are ever printed.
//
// Exit codes: 0 every event is accepted by the validation; 1 an event would be refused; 2 the run could not start
// (bad arguments, an unreadable or invalid plan, an entry too big for one batch).
import { validateEvent } from '../../src/sync/validate.js';
import { buildBatches, type BuildOptions } from './build.js';
import { PlanError, parsePlan } from './plan.js';

export interface Sink {
  write(text: string): unknown;
}

export interface MainDeps {
  stdout: Sink;
  stderr: Sink;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  now: () => Date;
}

export const USAGE =
  'usage: gk2-import --plan <plan.json> [--out <writes.json>] [--device <32 hex>] [--at <ISO time>] [--tz <IANA zone>] [--client-prefix <text>]';

const FLAGS = ['--plan', '--out', '--device', '--at', '--tz', '--client-prefix'] as const;
type Flag = (typeof FLAGS)[number];
const MAX_FAILURES_SHOWN = 20;

function parseArgs(argv: readonly string[]): Partial<Record<Flag, string>> | undefined {
  const out: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as Flag;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined) return undefined;
    out[flag] = value;
  }
  return out;
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const args = parseArgs(argv);
  const device = args?.['--device'] ?? '00000000000000000000000000000001';
  const tz = args?.['--tz'] ?? 'America/Chicago';
  const prefix = args?.['--client-prefix'] ?? 'gk2-import-1';
  const at = args?.['--at'] === undefined ? deps.now() : new Date(args['--at']);
  const usable =
    args?.['--plan'] !== undefined &&
    /^[0-9a-f]{32}$/.test(device) &&
    !Number.isNaN(at.getTime()) &&
    /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz) &&
    /^[\x21-\x7e]{1,120}$/.test(prefix);
  if (!usable) {
    deps.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let raw: string;
  try {
    raw = await deps.readFile(args['--plan']!);
  } catch {
    deps.stderr.write(`cannot read the plan: ${args['--plan']}\n`);
    return 2;
  }
  let plan;
  try {
    plan = parsePlan(JSON.parse(raw));
  } catch (err) {
    deps.stderr.write(err instanceof PlanError ? `plan: ${err.message}\n` : 'the plan is not JSON\n');
    return 2;
  }

  const opts: BuildOptions = { deviceHex: device, at, tz, clientPrefix: prefix };
  let built;
  try {
    built = buildBatches(plan, opts);
  } catch (err) {
    deps.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const ctx = { deviceHex: device, nowMicros: BigInt(at.getTime()) * 1000n };
  const refused: string[] = [];
  let events = 0;
  for (const batch of built.batches) {
    for (const w of batch.events) {
      events += 1;
      const verdict = validateEvent(w, ctx);
      if (!verdict.ok) refused.push(`${w.line === '' ? '(names)' : w.line}: ${w.facetKey}: ${verdict.reason.split(':')[0]}`);
    }
  }

  const byKind = (k: string) => plan.entries.filter((e) => e.kind === k).length;
  const copies = plan.entries.filter((e) => e.kind !== 'parked').reduce((n, e) => n + e.copies, 0);
  deps.stdout.write(`${plan.entries.length} entries: ${byKind('matched')} matched, ${byKind('text')} text, ${byKind('parked')} parked\n`);
  deps.stdout.write(`${copies} copies, ${events} events in ${built.batches.length} batches\n`);
  deps.stdout.write(`by family: ${Object.entries(built.counts).map(([f, n]) => `${f} ${n}`).join(', ')}\n`);
  if (built.parked.length > 0) deps.stdout.write(`parked, not written: ${built.parked.join(', ')}\n`);

  if (refused.length > 0) {
    deps.stderr.write(`${refused.length} events would be refused by the coordinator:\n`);
    for (const line of refused.slice(0, MAX_FAILURES_SHOWN)) deps.stderr.write(`  ${line}\n`);
    return 1;
  }
  deps.stdout.write("every event is accepted by the coordinator's Push validation\n");

  const out = args['--out'];
  if (out !== undefined) {
    const batches = built.batches.map((b) => ({
      clientId: b.clientId,
      events: b.events.map((w) => ({ facetKey: w.facetKey, version: w.version, op: 'SYNC_OP_UPSERT', payload: w.payload, basis: w.basis })),
    }));
    await deps.writeFile(out, `${JSON.stringify(batches, null, 1)}\n`);
    deps.stdout.write(`wrote ${out}\n`);
  }
  return 0;
}
