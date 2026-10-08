// coordinator.v1.ImportService.ImportMfcExport: import a user's MFC export, the first time or
// again (MG-1, WK-14a and WK-14b). Online only: the client has pushed its outbox first
// (import.proto ONLINE ONLY).
//
//   1. Read the export by header (./rows.ts): a missing ID or Status column, a cell that is not
//      what its column holds, csv_text over 2 MiB or a bad export_date is INVALID_ARGUMENT.
//   2. Resolve each MFC id to its spine head, 200 refs a call (./resolve.ts). Spine unreachable:
//      UNAVAILABLE, before anything is written; a retry is safe.
//   3. Under the user's lock, the one every Push takes, decide each figure (./plan.ts) and write
//      the result through the Push apply path (applyEvent) as ONE server transaction, its marker
//      imp/mfc/import last (sync.proto rule 7), each write versioned
//      <server instant>#<import number>#<reserved server device> and minted above the facet's own.
//
// Refused with FAILED_PRECONDITION before anything is written: an export whose row the spine now
// resolves to another figure than the one its row base names (a merge or a move), and a conflict a
// FAVOR preference would settle. Not built yet: divergence items, align-MFC entries and their
// acknowledgements, and the replay of a late edit, which ./holds.ts holds instead. The answers to
// the items this import raises are applied in Push (./answers.ts).
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import {
  ImportAnswer,
  ImportMfcExportResponseSchema,
  ImportReviewGroupSchema,
  ImportReviewItemSchema,
  ImportReviewKind,
  ImportService,
  UnresolvedMfcRowSchema,
  importMarkerKey,
  importPrefKey,
  type ImportMfcExportRequest,
  type ImportMfcExportResponse,
} from '@figurecollecting/fc-api-contract';
import type { SpineCatalog } from '../connect/catalog.js';
import { kCallerDevice, kCallerSubject } from '../connect/identity.js';
import {
  FeedTransaction,
  LOCK_NOT_AVAILABLE,
  applyEvent,
  boundLockWaits,
  feedHead,
  lockUser,
  readFacet,
  serverNow,
  transaction,
  type SyncPool,
} from '../sync/store.js';
import { importOccId } from './occ.js';
import { CHANGE_ITEM_PREFIX, FIGURE_ITEM_PREFIX, planImport, type Row } from './plan.js';
import { resolveMfcIds } from './resolve.js';
import { readExport, type ExportError, type ExportRow } from './rows.js';
import { lastImportNumber, readImportState, recordRun, saveBases, saveExportRows } from './store.js';
import { importVersion, writeVersion } from './version.js';

/** import.proto ImportMfcExportRequest.csv_text: at most 2 MiB of UTF-8. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
/** The import waits this long for its user's lock, then answers UNAVAILABLE, as a Push does. */
export const IMPORT_LOCK_TIMEOUT_MS = 5_000;
const SITE = 'mfc';
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ImportRoutesDeps {
  db: SyncPool;
  /** `null` = SPINE_READ_URL unset: an import that has ids to resolve answers UNAVAILABLE. */
  spineRead: SpineCatalog | null;
  /** The import occ-id key (IMPORT_OCC_ID_KEY); `null` = unset, and every import answers UNAVAILABLE. */
  occIdKey: Uint8Array | null;
  /** The clock export_date is checked against and the spine's now_iso. */
  now?: () => Date;
  lockTimeoutMs?: number;
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

/** export_date: "YYYY-MM-DD", a calendar date, no later than the server's UTC date plus one day. */
function checkExportDate(value: string, now: Date): void {
  const m = DATE.exec(value);
  if (m === null) throw invalid('export_date must be "YYYY-MM-DD"');
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const day = new Date(Date.UTC(y, mo, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo || day.getUTCDate() !== d) throw invalid('export_date is not a calendar date');
  // MFC stamps the date in its own zone, which can run a day ahead of UTC; anything later is a typo.
  if (day.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) {
    throw invalid('export_date is later than tomorrow, UTC');
  }
}

function readRows(csvText: string): ExportRow[] {
  try {
    return readExport(csvText);
  } catch (err) {
    // readExport throws ExportError and nothing else: the CSV reader's faults are wrapped in it.
    throw invalid((err as ExportError).message);
  }
}

export function createImportRoutes(deps: ImportRoutesDeps): (router: ConnectRouter) => void {
  const now = deps.now ?? (() => new Date());
  const lockTimeoutMs = deps.lockTimeoutMs ?? IMPORT_LOCK_TIMEOUT_MS;

  const importMfcExport = async (req: ImportMfcExportRequest, ctx: HandlerContext): Promise<ImportMfcExportResponse> => {
    const userId = ctx.values.get(kCallerSubject);
    // The edge refuses these first; this keeps a mis-wired app from importing as nobody.
    if (userId === null || ctx.values.get(kCallerDevice) === null) {
      throw new ConnectError('the import needs an authenticated, device-bound caller', Code.Unauthenticated);
    }
    const key = deps.occIdKey;
    if (key === null) throw new ConnectError('the MFC import is not configured', Code.Unavailable);
    if (Buffer.byteLength(req.csvText, 'utf8') > MAX_CSV_BYTES) throw invalid('csv_text is over 2 MiB');
    checkExportDate(req.exportDate, now());

    const rows = readRows(req.csvText);
    const asked = rows.filter((r) => r.reason === undefined);
    const heads = await resolveMfcIds(
      deps.spineRead,
      asked.map((r) => r.id!),
      now().toISOString(),
    );
    const resolved: Row[] = asked.flatMap((r) => {
      const head = heads.get(r.id!);
      return head === undefined ? [] : [{ id: r.id!, head, kind: r.kind, count: r.count!, fields: r.fields }];
    });
    const unresolved = rows.flatMap((r) => {
      const reason = r.reason ?? (heads.has(r.id!) ? undefined : 'no_product');
      return reason === undefined ? [] : [{ row: r, reason }];
    });
    // An id unresolved for its Count or its product states nothing new; a duplicate or an invalid id names none.
    const keepIds = unresolved.flatMap(({ row, reason }) => (reason === 'invalid_id' || reason === 'duplicate_id' ? [] : [row.id!]));

    const write = async (tx: Parameters<Parameters<typeof transaction>[1]>[0]): Promise<ImportMfcExportResponse> => {
      await boundLockWaits(tx, lockTimeoutMs);
      await lockUser(tx, userId);
      const importNumber = (await lastImportNumber(tx, userId)) + 1;
      const state = await readImportState(tx, userId);
      const plan = planImport({
        state,
        rows: resolved,
        keepIds,
        importNumber,
        exportDate: req.exportDate,
        occId: (mfcId, ordinal) => importOccId(key, userId, mfcId, ordinal),
      });
      if (plan.beyond.length > 0) {
        throw new ConnectError(
          `this export has rows the spine now resolves to another figure (a merge or a move), touching ${plan.beyond.length} figure(s); importing those is not built yet`,
          Code.FailedPrecondition,
        );
      }
      const pref = await readFacet(tx, userId, importPrefKey(SITE));
      const policy = pref?.op === 'upsert' ? (JSON.parse(pref.payload) as { import_policy: string }).import_policy : 'ASK';
      if (policy !== 'ASK' && plan.conflicted.length > 0) {
        throw new ConnectError(
          `import_policy ${policy} would settle ${plan.conflicted.length} conflict(s); settling by preference is not built yet: answer them, or set ASK`,
          Code.FailedPrecondition,
        );
      }

      const version = importVersion((await serverNow(tx)).iso, importNumber);
      const feed = new FeedTransaction();
      for (const w of plan.writes) {
        await applyEvent(tx, userId, { ...w, version: writeVersion(version, state.facets.get(w.facetKey)?.version) }, feed);
      }
      const marker = importMarkerKey(SITE);
      const previous = await readFacet(tx, userId, marker);
      await applyEvent(
        tx,
        userId,
        { facetKey: marker, op: 'upsert', payload: JSON.stringify({ import: importNumber, export_date: req.exportDate }), version: writeVersion(version, previous?.version) },
        feed,
      );
      await recordRun(tx, userId, { importNumber, exportDate: req.exportDate, version, markerSeq: await feedHead(tx, userId), figures: plan.figures, settled: plan.settled });
      await saveBases(tx, userId, importNumber, {
        rows: plan.rowBases,
        rowsGone: plan.rowBasesGone,
        copies: plan.copyBases,
        fields: plan.fieldBases,
        items: plan.items,
        kept: { add: new Map(), gone: plan.keptGone },
      });
      await saveExportRows(tx, userId, plan.exportRows);

      const item = (prefix: string, answers: ImportAnswer[]) => (entry: { head: string; rev: string; payload: string }) =>
        create(ImportReviewItemSchema, { facetKey: `${prefix}${entry.head}`, headId: entry.head, rev: entry.rev, answers, payload: entry.payload });
      const review = plan.pending.map(item(FIGURE_ITEM_PREFIX, [ImportAnswer.KEEP, ImportAnswer.TAKE, ImportAnswer.PER_COPY]));
      return create(ImportMfcExportResponseSchema, {
        resolved: resolved.length,
        unresolved: unresolved.map(({ row, reason }) =>
          create(UnresolvedMfcRowSchema, { mfcId: row.rawId, status: row.rawStatus, line: row.line, reason }),
        ),
        added: plan.stats.added,
        moved: plan.stats.moved,
        unchanged: plan.stats.unchanged,
        removed: plan.stats.removed,
        keptNewer: plan.stats.keptNewer,
        facetsWritten: plan.writes.length + 1,
        occurrencesAdded: plan.stats.occurrencesAdded,
        occurrencesStatusChanged: plan.stats.occurrencesStatusChanged,
        occurrencesRemoved: plan.stats.occurrencesRemoved,
        conflictsRaised: plan.stats.conflictsRaised,
        conflictsPending: plan.pending.length,
        importNumber,
        review:
          review.length === 0
            ? []
            : [create(ImportReviewGroupSchema, { kind: ImportReviewKind.CONFLICT, items: review, bulk: [ImportAnswer.KEEP, ImportAnswer.TAKE] })],
        applied: plan.applied.map(item(CHANGE_ITEM_PREFIX, [ImportAnswer.UNDO, ImportAnswer.DISMISS])),
      });
    };

    try {
      return await transaction(deps.db, write);
    } catch (err) {
      if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
        throw new ConnectError("this user's writes are held elsewhere: retry later", Code.Unavailable);
      }
      throw err;
    }
  };

  return (router: ConnectRouter) => {
    router.service(ImportService, { importMfcExport });
  };
}
