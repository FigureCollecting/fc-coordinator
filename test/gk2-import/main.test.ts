import { describe, expect, it } from 'vitest';
import { main, type MainDeps } from '../../scripts/gk2-import/main.js';

const NS = '7d0c1d9e-5a43-4c52-9d4f-6f2a4b8f1c07';
const HEAD = '3907070b-50f1-4f99-b912-6d63db4bf805';
const SECRET = 'PRIVATE-NOTE-TEXT';
const PLAN = {
  namespace: NS,
  entries: [
    { line: 'owned-3', kind: 'matched', status: 'owned', headId: HEAD, copies: 1, links: ['https://a.example/1'], tags: [], note: SECRET },
    { line: 'owned-8', kind: 'text', status: 'owned', copies: 2, label: { name: 'Katfight' }, links: [], tags: [] },
    { line: 'owned-19', kind: 'parked', status: 'owned', headId: HEAD, copies: 1, links: [], tags: [] },
  ],
};

function rig(files: Record<string, string>, now = new Date('2026-10-21T20:00:00.000Z')) {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const deps: MainDeps = {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
    writeFile: async (path, data) => void written.set(path, data),
    now: () => now,
  };
  return { deps, out: () => out.join(''), err: () => err.join(''), written };
}
const planFile = (over: object = {}) => ({ '/p/plan.json': JSON.stringify({ ...PLAN, ...over }) });

describe('main', () => {
  it('prints the counts of a plan it can build and validate, and exits 0 without writing anything', async () => {
    const r = rig(planFile());
    expect(await main(['--plan', '/p/plan.json'], r.deps)).toBe(0);
    expect(r.out()).toMatch(/3 entries: 1 matched, 1 text, 1 parked/);
    expect(r.out()).toMatch(/3 copies/);
    expect(r.out()).toMatch(/parked, not written: owned-19/);
    expect(r.out()).toMatch(/every event is accepted by the coordinator's Push validation/);
    expect(r.written.size).toBe(0);
  });

  it('writes the batches as JSON to --out, and says where', async () => {
    const r = rig(planFile());
    expect(await main(['--plan', '/p/plan.json', '--out', '/p/writes.json'], r.deps)).toBe(0);
    const batches = JSON.parse(r.written.get('/p/writes.json')!) as { clientId: string; events: { facetKey: string; payload: string; version: string; op: string; basis: string }[] }[];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.clientId).toBe('gk2-import-1-0001');
    expect(batches[0]!.events.map((e) => e.op)).toEqual(Array(batches[0]!.events.length).fill('SYNC_OP_UPSERT'));
    expect(r.out()).toMatch(/wrote \/p\/writes\.json/);
  });

  it('never prints a note, a label or a link: counts and keys only', async () => {
    const r = rig(planFile());
    await main(['--plan', '/p/plan.json'], r.deps);
    for (const text of [r.out(), r.err()]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('Katfight');
      expect(text).not.toContain('a.example');
    }
  });

  it('stamps the writes with the options it is given, and with the clock when --at is absent', async () => {
    const a = rig(planFile());
    await main(['--plan', '/p/plan.json', '--out', '/o.json', '--device', 'ab'.repeat(16), '--tz', 'Asia/Tokyo', '--at', '2026-01-02T03:04:05.000Z', '--client-prefix', 'run-9'], a.deps);
    const sent = JSON.parse(a.written.get('/o.json')!) as { clientId: string; events: { version: string; payload: string }[] }[];
    expect(sent[0]!.clientId).toBe('run-9-0001');
    expect(sent[0]!.events[0]!.version).toBe(`2026-01-02T03:04:05.000000Z#0000000001#${'ab'.repeat(16)}`);
    expect(JSON.parse(sent[0]!.events[0]!.payload)).toMatchObject({ tz: 'Asia/Tokyo', edited_at: '2026-01-02T03:04:05.000Z' });
    const b = rig(planFile());
    await main(['--plan', '/p/plan.json', '--out', '/o.json'], b.deps);
    const dflt = JSON.parse(b.written.get('/o.json')!) as { events: { version: string; payload: string }[] }[];
    expect(dflt[0]!.events[0]!.version.startsWith('2026-10-21T20:00:00.000000Z#')).toBe(true);
    expect(JSON.parse(dflt[0]!.events[0]!.payload)).toMatchObject({ tz: 'America/Chicago' });
  });

  it('exits 1 and names the line and key of an event the coordinator would refuse, with nothing written', async () => {
    const bad = { ...PLAN, entries: [{ ...PLAN.entries[0]!, links: ['javascript:alert(1)'] }] };
    const r = rig({ '/p/plan.json': JSON.stringify(bad) });
    expect(await main(['--plan', '/p/plan.json', '--out', '/o.json'], r.deps)).toBe(1);
    expect(r.err()).toMatch(/owned-3: uf\/[0-9a-f-]+\/refs: payload_invalid/);
    expect(r.err()).not.toContain('javascript');
    expect(r.written.size).toBe(0);
  });

  it('names a refused collection or tag name as (names), since it belongs to no line', async () => {
    const bad = { ...PLAN, entries: [{ ...PLAN.entries[0]!, tags: ['x'.repeat(101)] }] };
    const r = rig({ '/p/plan.json': JSON.stringify(bad) });
    expect(await main(['--plan', '/p/plan.json'], r.deps)).toBe(1);
    expect(r.err()).toMatch(/\(names\): tag\/[0-9a-f-]+\/name: payload_invalid/);
  });

  it.each([
    ['no arguments', []],
    ['no --plan', ['--out', '/o.json']],
    ['an unknown option', ['--plan', '/p/plan.json', '--send']],
    ['an option with no value', ['--plan']],
    ['a device that is not 32 lowercase hex', ['--plan', '/p/plan.json', '--device', 'xyz']],
    ['an --at that is not a time', ['--plan', '/p/plan.json', '--at', 'yesterday']],
    ['a --tz that is not an IANA name', ['--plan', '/p/plan.json', '--tz', 'America/New York']],
    ['a --client-prefix with a space', ['--plan', '/p/plan.json', '--client-prefix', 'a b']],
    ['a --client-prefix too long for a client id', ['--plan', '/p/plan.json', '--client-prefix', 'a'.repeat(125)]],
  ])('exits 2 with the usage on %s', async (_why, argv) => {
    const r = rig(planFile());
    expect(await main(argv, r.deps)).toBe(2);
    expect(r.err()).toMatch(/usage: gk2-import --plan/);
  });

  it('exits 2 when the plan file cannot be read or is not JSON or is not a plan', async () => {
    const missing = rig({});
    expect(await main(['--plan', '/nope.json'], missing.deps)).toBe(2);
    expect(missing.err()).toMatch(/cannot read the plan/);
    const junk = rig({ '/p/plan.json': '{' });
    expect(await main(['--plan', '/p/plan.json'], junk.deps)).toBe(2);
    expect(junk.err()).toMatch(/not JSON/);
    const wrong = rig({ '/p/plan.json': JSON.stringify({ namespace: NS, entries: [{ line: 'x' }] }) });
    expect(await main(['--plan', '/p/plan.json'], wrong.deps)).toBe(2);
    expect(wrong.err()).toMatch(/plan: /);
  });

  it('exits 2 when a batch cannot be built (an entry too big for one)', async () => {
    const big = { ...PLAN, entries: [{ line: 'owned-1', kind: 'matched', status: 'owned', headId: HEAD, copies: 99, links: [], tags: ['a', 'b'] }] };
    const r = rig({ '/p/plan.json': JSON.stringify(big) });
    expect(await main(['--plan', '/p/plan.json'], r.deps)).toBe(2);
    expect(r.err()).toMatch(/200/);
  });
});
