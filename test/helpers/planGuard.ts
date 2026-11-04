// The plan guard's machinery (PLAN.md U12c). Statements are captured as they reach the driver, with
// the values the code bound, and each is explained the way node-postgres sends it: an unnamed
// statement, planned with its real parameters (a custom plan), never with current_setting() or with
// literals pasted in. A read is run under EXPLAIN (ANALYZE, BUFFERS) twice and judged on the second
// (warm) run; a write is planned only, since running it again would collide with what it wrote.
import type pg from 'pg';

export interface Captured {
  /** The scenario the statement ran in ('whale', '1x', ...). */
  scope: string;
  text: string;
  values: readonly unknown[];
}

/** One statement shape the guard knows, and the bound its plan is held to. */
export interface GuardEntry {
  id: string;
  /** Matched against the statement text with its whitespace collapsed. */
  match: RegExp;
  /** control: transaction control, locks, clocks, settings - never explained. */
  kind: 'read' | 'write' | 'control';
  /**
   * Shared buffers the warm run may touch: base + perRow x rows returned. Every read has one; the
   * defaults hold a statement to a few index pages per row it returns.
   */
  buffers?: { base: number; perRow: number };
  /**
   * A known excess with an owner and a date: the entry's violations are reported, not failed,
   * until `until` (YYYY-MM-DD). An expired allowance fails the guard. Kept here, never in the checker.
   */
  allow?: { reason: string; until: string };
}

/**
 * Tables that grow with users and history, and that the fill makes big (the shape test checks each
 * holds at least 5,000 rows): reading one whole, or walking its index without a bound, fails. The
 * insert-only review tables (held_edit, import_late_edit, import_revision) are near-empty in prod and
 * here; their growth is U11's (retention), so a seq scan of one is the right plan today.
 */
export const BIG_TABLES = new Set([
  'feed_event',
  'facet_state',
  'mutation_receipt',
  'import_frame',
  'import_row_base',
  'import_copy_base',
  'import_field_base',
  'import_kept_copy',
  'import_export_row',
]);

export const DEFAULT_BUFFERS = { base: 40, perRow: 8 };

/** A pg.Pool that records every statement (pool.query and the clients pool.connect hands out). */
export function spyPool(pool: pg.Pool, record: (text: string, values: readonly unknown[]) => void): pg.Pool {
  const capture = (args: unknown[]): void => {
    const [first, second] = args;
    if (typeof first === 'string') record(first, Array.isArray(second) ? second : []);
    else if (first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      const q = first as { text: string; values?: unknown[] };
      record(q.text, q.values ?? (Array.isArray(second) ? second : []));
    }
  };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t) as unknown;
        if (prop === 'query' && typeof value === 'function') {
          return (...args: unknown[]) => {
            capture(args);
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === 'connect' && typeof value === 'function') {
          return async (...args: unknown[]) => wrap((await (value as (...a: unknown[]) => Promise<object>).apply(t, args)) as object);
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });
  return wrap(pool);
}

export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Parent Relationship'?: string;
  'Subplan Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

export interface Judged {
  entry: string;
  scope: string;
  text: string;
  rows: number;
  buffers: number;
  removed: number;
  ms: number;
  violations: string[];
  plan: string;
}

const relationOf = (n: PlanNode): string | undefined => n['Relation Name'];

function walk(n: PlanNode, visit: (n: PlanNode, inSubPlan: boolean) => void, inSubPlan = false): void {
  const sub = inSubPlan || n['Parent Relationship'] === 'SubPlan';
  visit(n, sub);
  for (const c of n.Plans ?? []) walk(c, visit, sub);
}

/** One line per node, indented: what the report and the failure message show. */
export function planText(n: PlanNode, depth = 0): string {
  const loops = n['Actual Loops'] ?? 1;
  const bits = [
    n['Node Type'],
    n['Index Name'] !== undefined ? `using ${n['Index Name']}` : '',
    relationOf(n) !== undefined ? `on ${relationOf(n)}` : '',
    n['Index Cond'] !== undefined ? `cond ${n['Index Cond']}` : '',
    n['Actual Rows'] !== undefined ? `rows=${n['Actual Rows']}x${loops}` : '',
    (n['Rows Removed by Filter'] ?? 0) > 0 ? `removed=${n['Rows Removed by Filter']}` : '',
    n['Shared Hit Blocks'] !== undefined ? `buf=${(n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0)}` : '',
  ].filter(Boolean);
  return [`${'  '.repeat(depth)}${bits.join(' ')}`, ...(n.Plans ?? []).map((c) => planText(c, depth + 1))].join('\n');
}

/** The structural checks, shared by reads and writes: a whole read, an unbounded index walk, a repeated SubPlan over a big table. */
export function structuralViolations(root: PlanNode, analysed: boolean): string[] {
  const out: string[] = [];
  walk(root, (n, inSubPlan) => {
    const rel = relationOf(n);
    if (rel === undefined || !BIG_TABLES.has(rel)) return;
    if (n['Node Type'] === 'Seq Scan') out.push(`whole read of ${rel} (Seq Scan)`);
    if (/Index/.test(n['Node Type']) && n['Index Cond'] === undefined && n['Node Type'] !== 'Bitmap Heap Scan') {
      out.push(`${n['Node Type']} of ${n['Index Name'] ?? rel} without an Index Cond`);
    }
    // A SubPlan repeated per outer row is a defect when each run walks and throws rows away (C-4's
    // 70k rows per frame row); one bounded probe per import run (an index Limit 1) is the design.
    const filtered = (n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0);
    if (analysed && inSubPlan && (n['Actual Loops'] ?? 1) > 1 && filtered > 0) {
      out.push(`correlated SubPlan over ${rel} ran ${n['Actual Loops']} times, removing ${filtered} rows per run`);
    }
  });
  // A Bitmap Index Scan names its index, not its table: an unbounded one is as bad.
  walk(root, (n) => {
    if (n['Node Type'] === 'Bitmap Index Scan' && n['Index Cond'] === undefined) out.push(`Bitmap Index Scan of ${n['Index Name']} without an Index Cond`);
  });
  return out;
}

function removedRows(root: PlanNode): number {
  let removed = 0;
  walk(root, (n) => {
    removed += ((n['Rows Removed by Filter'] ?? 0) + (n['Rows Removed by Index Recheck'] ?? 0)) * (n['Actual Loops'] ?? 1);
  });
  return removed;
}

/** Where a statement is explained: the admin pool, or one client inside a transaction that changed the schema. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Explain one captured statement and judge it against its entry. */
export async function judge(admin: Queryable, entry: GuardEntry, c: Captured): Promise<Judged> {
  const analysed = entry.kind === 'read';
  const explain = analysed ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ';
  const run = async () => (await admin.query<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time'?: number }] }>(explain + c.text, [...c.values])).rows[0]!['QUERY PLAN'][0];
  if (analysed) await run();
  const out = await run();
  const root = out.Plan;
  const rows = analysed ? (root['Actual Rows'] ?? 0) * (root['Actual Loops'] ?? 1) : 0;
  const buffers = (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0);
  const removed = analysed ? removedRows(root) : 0;
  const violations = structuralViolations(root, analysed);
  if (analysed) {
    const b = entry.buffers ?? DEFAULT_BUFFERS;
    const cap = b.base + b.perRow * rows;
    if (buffers > cap) violations.push(`${buffers} buffers for ${rows} rows (bound ${cap})`);
    const removedCap = 100 + 20 * rows;
    if (removed > removedCap) violations.push(`${removed} rows removed for ${rows} returned (bound ${removedCap})`);
  }
  return { entry: entry.id, scope: c.scope, text: normalise(c.text), rows, buffers, removed, ms: out['Execution Time'] ?? 0, violations, plan: planText(root) };
}
