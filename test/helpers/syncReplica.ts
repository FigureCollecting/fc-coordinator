// A 0.3.0 client of SyncService, as sync.proto rule 7 and rule 6 (THE IMPORT, ON A CLIENT) describe
// it: a replica merged by LWW that applies a server transaction only once it holds the event
// carrying commit_cursor, keeps the rest of a page staged until then, mints every edit on the
// commit_cursor of the last transaction it applied (its basis), and after a restart resumes from
// that commit_cursor and fetches what it had staged again.
import { compareVersion, type SyncEvent, type SyncOp } from '@figurecollecting/fc-api-contract';
import { ok, type SyncCaller } from './syncClient.js';

export interface ReplicaFacet {
  version: string;
  op: SyncOp;
  payload: string;
}

export class Replica {
  readonly local = new Map<string, ReplicaFacet>();
  /** Every event taken out of staging, as `facet_key@version`, in order: a re-applied transaction shows twice. */
  readonly processed: string[] = [];
  /** The commit_cursor of every transaction applied, in order. */
  readonly commits: string[] = [];
  /** Fetched, and waiting for the event that carries its transaction's commit_cursor. */
  staged: SyncEvent[] = [];
  /** The commit_cursor of the last transaction applied, '' before any: the basis of every edit. */
  basis = '';
  /** Where the next Delta starts: past what is staged. */
  private next = '';

  constructor(readonly caller: SyncCaller) {}

  /** One Delta page; true while the server says more is waiting. */
  async pull(limit = 0): Promise<boolean> {
    const page = ok(await this.caller.delta({ cursor: this.next, limit }));
    for (const event of page.events) {
      this.staged.push(event);
      if (event.commitCursor === '') continue;
      for (const staged of this.staged) this.apply(staged);
      this.staged = [];
      this.basis = event.commitCursor;
      this.commits.push(event.commitCursor);
    }
    this.next = page.nextCursor;
    return page.hasMore;
  }

  async pullAll(limit = 0): Promise<void> {
    while (await this.pull(limit));
  }

  /** What was staged in memory is gone; the next pull starts again from the last commit applied. */
  restart(): void {
    this.staged = [];
    this.next = this.basis;
  }

  /** Adopt an event by LWW: only a higher version replaces the local one. */
  offer(event: SyncEvent): void {
    const local = this.local.get(event.facetKey);
    if (local === undefined || compareVersion(event.version, local.version) > 0) {
      this.local.set(event.facetKey, { version: event.version, op: event.op, payload: event.payload });
    }
  }

  private apply(event: SyncEvent): void {
    this.processed.push(`${event.facetKey}@${event.version}`);
    this.offer(event);
  }
}
