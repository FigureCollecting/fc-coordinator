// The rows of an MFC export (import.proto ROWS), found by header because MFC lets the user choose
// the columns. ID and Status are required; Count, Score, Wishability and Note are read when
// present; every other column (Title, the two Price columns, Shop, the dates) is ignored. A row
// gets the first of the reasons the export alone can give (invalid_id, duplicate_id,
// invalid_count, count_over_99); no_product is the spine's to give.
import { canonicalMfcId } from '@figurecollecting/fc-api-contract';
import { CsvError, parseCsv } from './csv.js';

export type Kind = 'owned' | 'ordered' | 'wished';
export type Field = 'score' | 'note' | 'wishability';
export type FieldValues = Partial<{ score: number; note: string; wishability: number }>;
export type ExportReason = 'invalid_id' | 'duplicate_id' | 'invalid_count' | 'count_over_99';

export interface ExportRow {
  line: number;
  /** The ID and Status cells as the export has them, for UnresolvedMfcRow. */
  rawId: string;
  rawStatus: string;
  /** The canonical MFC id; null when the cell has none. */
  id: string | null;
  kind: Kind;
  /** Copies the row states; blank is 1, null when the cell is not a Count. */
  count: number | null;
  /** The figure values the row states: a blank cell states none. */
  fields: FieldValues;
  reason?: ExportReason;
}

/** An export the import cannot read at all: INVALID_ARGUMENT. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

const KINDS: Record<string, Kind> = { owned: 'owned', ordered: 'ordered', wished: 'wished' };
/** A note's limit (schemas/uf-note.schema.json), in code points. */
export const MAX_NOTE_CODE_POINTS = 10_000;
const SCORE = /^(10|[0-9])\/10$/;
const WISHABILITY = /^[0-5]$/;

const blank = (cell: string): boolean => cell.trim() === '';

export function readExport(text: string): ExportRow[] {
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    throw new ExportError(`the export is not readable CSV: ${(err as CsvError).message}`);
  }
  const header = records[0]?.fields.map((h) => h.trim().toLowerCase()) ?? [];
  // The first column of a name wins: MFC writes Price twice.
  const column = (name: string): number => header.indexOf(name.toLowerCase());
  const required = (name: string): number => {
    const at = column(name);
    if (at < 0) throw new ExportError(`the export has no "${name}" column`);
    return at;
  };
  const idAt = required('ID');
  const statusAt = required('Status');
  const [countAt, scoreAt, wishAt, noteAt] = ['Count', 'Score', 'Wishability', 'Note'].map(column) as [number, number, number, number];

  const seen = new Set<string>();
  return records.slice(1).map(({ line, fields: cells }) => {
    const cell = (at: number): string => (at < 0 ? '' : (cells[at] ?? ''));
    const refuse = (name: string, why: string): never => {
      throw new ExportError(`line ${line}: ${name} ${why}`);
    };
    const rawId = cell(idAt);
    const rawStatus = cell(statusAt);
    const kind = KINDS[rawStatus.trim().toLowerCase()] ?? refuse('Status', `"${rawStatus}" is not Owned, Ordered or Wished`);
    const fields = figureValues(cell(scoreAt), cell(wishAt), cell(noteAt), refuse);

    const countCell = cell(countAt).trim();
    const count = countCell === '' ? 1 : /^[0-9]+$/.test(countCell) ? Number(countCell) : null;
    let id: string | null = null;
    let reason: ExportReason | undefined;
    try {
      id = canonicalMfcId(rawId);
    } catch {
      reason = 'invalid_id';
    }
    if (id !== null) {
      if (seen.has(id)) reason = 'duplicate_id';
      else if (count === null) reason = 'invalid_count';
      else if (count > 99) reason = 'count_over_99';
      seen.add(id);
    }
    return { line, rawId, rawStatus, id, kind, count, fields, ...(reason !== undefined ? { reason } : {}) };
  });
}

function figureValues(score: string, wishability: string, note: string, refuse: (name: string, why: string) => never): FieldValues {
  const fields: FieldValues = {};
  if (!blank(score)) {
    const m = SCORE.exec(score.trim()) ?? refuse('Score', `"${score}" is not a score "N/10"`);
    if (m[1] !== '0') fields.score = Number(m[1]);
  }
  if (!blank(wishability)) {
    if (!WISHABILITY.test(wishability.trim())) refuse('Wishability', `"${wishability}" is not 0 to 5`);
    if (wishability.trim() !== '0') fields.wishability = Number(wishability.trim());
  }
  if (!blank(note)) {
    if ([...note].length > MAX_NOTE_CODE_POINTS) refuse('Note', `is over ${MAX_NOTE_CODE_POINTS} code points`);
    fields.note = note;
  }
  return fields;
}
