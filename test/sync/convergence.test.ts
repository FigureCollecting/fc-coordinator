// (1) Convergence. Two devices of one user, each on its own replica, edit offline (some edits
// invalid, so REJECTED), push and pull in random interleavings, lose responses, and push
// concurrently. Each device follows the contract's client rules, so the property is: both end on
// the same facet map, equal to a replay from an empty cursor and to the server's facet_state.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import {
  Hlc,
  PushOutcome,
  SyncOp,
  compareVersion,
  userFacetKey,
  type HlcClock,
  type PushResult,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISPLAY, ok, startSyncApp, SyncCaller, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
let h: SyncApp;
let h2: SyncApp;
let rejected = 0;

beforeAll(async () => {
  db = await startSyncDatabase();
  h = await startSyncApp(db.app);
  h2 = await startSyncApp(db.app, h.issuer);
}, 240_000);

afterAll(async () => {
  await h2?.close();
  await h?.close();
  await db?.close();
});

interface Facet {
  version: string;
  op: SyncOp;
  payload: string;
}
type Edit = { facetKey: string } & Facet;

/** A device that follows sync.proto's client rules and nothing else. */
class SimDevice {
  readonly local = new Map<string, Facet>();
  private outbox: Edit[] = [];
  private inflight: { clientId: string; events: Edit[] } | undefined;
  private cursor = '';
  private readonly hlc: Hlc;

  constructor(
    readonly caller: SyncCaller,
    clock: HlcClock,
  ) {
    this.hlc = new Hlc({ deviceId: caller.deviceId, clock });
  }

  edit(facetKey: string, op: SyncOp, payload: string): void {
    const version = this.hlc.tick(this.local.get(facetKey)?.version);
    this.local.set(facetKey, { version, op, payload });
    this.outbox.push({ facetKey, version, op, payload });
  }

  /** Send the frozen batch, or freeze the outbox into a new one. A dropped response keeps it frozen. */
  async push(drop: boolean): Promise<void> {
    if (this.inflight === undefined) {
      if (this.outbox.length === 0) return;
      this.inflight = { clientId: randomUUID(), events: this.outbox.splice(0, 200) };
    }
    const batch = this.inflight;
    const res = ok(await this.caller.push(batch));
    if (drop) return;
    expect(res.results).toHaveLength(batch.events.length);
    res.results.forEach((result, i) => this.settle(batch.events[i]!, result));
    this.inflight = undefined;
  }

  async delta(limit: number, drop: boolean): Promise<boolean> {
    const page = ok(await this.caller.delta({ cursor: this.cursor, limit }));
    if (drop) return true;
    for (const event of page.events) this.offer(event);
    this.cursor = page.nextCursor;
    return page.hasMore;
  }

  async settleAll(): Promise<void> {
    while (this.inflight !== undefined || this.outbox.length > 0) await this.push(false);
    while (await this.delta(0, false));
  }

  private settle(sent: Edit, result: PushResult): void {
    expect(result.facetKey).toBe(sent.facetKey);
    expect([PushOutcome.APPLIED, PushOutcome.DUPLICATE, PushOutcome.STALE, PushOutcome.REJECTED]).toContain(result.outcome);
    if (result.outcome === PushOutcome.REJECTED) rejected += 1;
    const local = this.local.get(sent.facetKey);
    if (local?.version === sent.version) {
      if (result.current) this.adopt(result.current);
      else this.local.delete(sent.facetKey);
    } else if (result.current) {
      this.offer(result.current);
    }
  }

  private offer(event: SyncEvent): void {
    const local = this.local.get(event.facetKey);
    if (local === undefined || compareVersion(event.version, local.version) > 0) this.adopt(event);
  }

  private adopt(event: SyncEvent): void {
    this.local.set(event.facetKey, { version: event.version, op: event.op, payload: event.payload });
    this.hlc.observe(event.version);
  }
}

const HEADS = [randomUUID(), randomUUID(), randomUUID()];
const FIELDS = ['status', 'count', 'score', 'note'] as const;

function payloadFor(field: (typeof FIELDS)[number], n: number): string {
  switch (field) {
    case 'status':
      return JSON.stringify({ status: ['owned', 'ordered', 'wished'][n % 3], ...DISPLAY });
    case 'count':
      return JSON.stringify({ count: 1 + (n % 9999), ...DISPLAY });
    case 'score':
      return JSON.stringify({ score: 1 + (n % 10), ...DISPLAY });
    case 'note':
      return JSON.stringify({ note: `note ${n}`, ...DISPLAY });
  }
}

const device = fc.constantFrom(0 as const, 1 as const);
const command = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      d: device,
      head: fc.nat({ max: HEADS.length - 1 }),
      field: fc.constantFrom(...FIELDS),
      remove: fc.nat({ max: 4 }).map((n) => n === 0),
      bad: fc.nat({ max: 3 }).map((n) => n === 0),
      n: fc.nat({ max: 1000 }),
      tickMs: fc.nat({ max: 2 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('push' as const), d: device, drop: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('pushBoth' as const), drops: fc.tuple(fc.boolean(), fc.boolean()) }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('delta' as const), d: device, limit: fc.integer({ min: 1, max: 4 }), drop: fc.boolean() }),
  },
);

const sorted = (map: Map<string, Facet>) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

describe('(1) convergence', () => {
  it('two devices with random offline edits, interleavings and dropped responses converge on a fresh replay', async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 30 }), fc.integer({ min: 1, max: 6 }), async (commands, replayPage) => {
        runs += 1;
        // One shared test clock an hour in the past: equal wall readings force HLC ties that only
        // the counter and the device id can break, and nothing is ever version_future.
        let t = 0;
        const base = Date.now() - 3_600_000;
        const clock: HlcClock = { wallMs: () => base + t, monoMs: () => t };

        const a = await SyncCaller.enrol(h);
        const b = (await SyncCaller.sibling(h, a)).via(h2);
        const devices = [new SimDevice(a, clock), new SimDevice(b, clock)] as const;

        for (const cmd of commands) {
          switch (cmd.kind) {
            case 'edit': {
              t += cmd.tickMs;
              const key = userFacetKey(HEADS[cmd.head]!, cmd.field);
              const payload = cmd.bad ? JSON.stringify({ unknown_field: true, ...DISPLAY }) : payloadFor(cmd.field, cmd.n);
              devices[cmd.d].edit(key, cmd.remove ? SyncOp.DELETE : SyncOp.UPSERT, cmd.remove ? '' : payload);
              break;
            }
            case 'push':
              await devices[cmd.d].push(cmd.drop);
              break;
            case 'pushBoth':
              await Promise.all([devices[0].push(cmd.drops[0]), devices[1].push(cmd.drops[1])]);
              break;
            case 'delta':
              await devices[cmd.d].delta(cmd.limit, cmd.drop);
              break;
          }
        }

        await devices[0].settleAll();
        await devices[1].settleAll();
        await devices[0].settleAll();

        const replay = new SimDevice(a, clock);
        while (await replay.delta(replayPage, false));

        const server = await db.admin.query<{ facet_key: string; version: string; op: string; payload: string }>(
          'SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = $1',
          [a.userId],
        );
        const authoritative = new Map<string, Facet>(
          server.rows.map((r) => [r.facet_key, { version: r.version, op: r.op === 'delete' ? SyncOp.DELETE : SyncOp.UPSERT, payload: r.payload }]),
        );

        expect(sorted(devices[0].local)).toEqual(sorted(devices[1].local));
        expect(sorted(devices[0].local)).toEqual(sorted(replay.local));
        expect(sorted(replay.local)).toEqual(sorted(authoritative));
      }),
      {
        numRuns: 200,
        // Found by review: A's invalid edit is REJECTED with the response lost, A pulls B's older
        // write and keeps its pending edit, then the retry's REJECTED answer must carry B's write.
        examples: [
          [
            [
              { kind: 'edit', d: 1, head: 0, field: 'score', remove: false, bad: false, n: 3, tickMs: 1 },
              { kind: 'edit', d: 0, head: 0, field: 'score', remove: false, bad: true, n: 0, tickMs: 1 },
              { kind: 'push', d: 0, drop: true },
              { kind: 'push', d: 1, drop: false },
              { kind: 'delta', d: 0, limit: 4, drop: false },
              { kind: 'push', d: 0, drop: false },
            ],
            1,
          ],
        ],
      },
    );
    expect(runs).toBeGreaterThanOrEqual(200);
    expect(rejected).toBeGreaterThan(50);
  }, 600_000);
});
