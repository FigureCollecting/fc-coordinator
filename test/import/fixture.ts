// An export SHAPED like Ross's MFC export of 2026-09-09, built from nothing of his: the twenty
// columns MFC writes with every column on (Price twice), every cell quoted, CRLF, 1,144 rows of
// which 556 are Owned x1, 4 Owned x2, 10 Ordered and 574 Wished; 118 scores "N/10" on Owned rows;
// wishability 1 to 5 on 570 Wished rows and 0 on the other four; 11 notes, two over several lines.
// Ids and titles are synthetic. If every row resolves it is 1,148 occurrences.
import { createHash } from 'node:crypto';

export const MFC_COLUMNS = [
  'ID', 'Title', 'Root', 'Category', 'Release Date', 'Price', 'Scale', 'Barcode', 'Status', 'Count', 'Score',
  'Payment date', 'Shipping date', 'Collecting date', 'Price', 'Shop', 'Shipping method', 'Tracking number', 'Wishability', 'Note',
] as const;

export interface FixtureRow {
  id: string;
  status: 'Owned' | 'Ordered' | 'Wished';
  count: string;
  score: string;
  wishability: string;
  note: string;
}

/** A head the fake spine resolves an MFC id to: a lowercase dashed uuid derived from the id. */
export function headFor(id: string): string {
  const h = createHash('sha256').update(`head:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function rossShapedRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  let next = 119;
  const id = () => String((next += 3137) % 3_900_000);
  const notes = ['boxed', 'pre-owned, "mint"', 'line one\r\nline two; with a semicolon', 'gift', 'x', 'shelf 3', 'loose', 'repaint', 'signed', 'damaged box', 'a\r\nb\r\nc'];
  for (let i = 0; i < 560; i += 1) {
    rows.push({
      id: id(),
      status: 'Owned',
      count: i < 4 ? '2' : '1',
      score: i < 118 ? `${(i % 10) + 1}/10` : '',
      wishability: '0',
      note: i >= 200 && i < 211 ? notes[i - 200]! : '',
    });
  }
  for (let i = 0; i < 10; i += 1) rows.push({ id: id(), status: 'Ordered', count: '1', score: '', wishability: '0', note: '' });
  for (let i = 0; i < 574; i += 1) rows.push({ id: id(), status: 'Wished', count: '1', score: '', wishability: i < 570 ? String((i % 5) + 1) : '0', note: '' });
  // Interleave the statuses the way a real export sorts by id rather than by status.
  return rows.map((r, i) => ({ r, k: (i * 7919) % rows.length })).sort((a, b) => a.k - b.k).map(({ r }) => r);
}

const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** The rows as MFC writes them: all twenty columns, quoted, comma-delimited, CRLF. */
export function mfcCsv(rows: readonly FixtureRow[]): string {
  const lines = [MFC_COLUMNS.map(cell).join(',')];
  for (const r of rows) {
    const byName: Record<string, string> = {
      ID: r.id, Title: `Figure ${r.id}`, Root: 'Figures', Category: 'Prepainted', 'Release Date': '2026-03-01', Price: '12800', Scale: '1/7',
      Barcode: '', Status: r.status, Count: r.count, Score: r.score, 'Payment date': '', 'Shipping date': '', 'Collecting date': '',
      Shop: '', 'Shipping method': '', 'Tracking number': '', Wishability: r.wishability, Note: r.note,
    };
    lines.push(MFC_COLUMNS.map((c) => cell(byName[c]!)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** The same rows with the user's own column choice and order, ';'-delimited, LF. */
export function semicolonCsv(rows: readonly FixtureRow[]): string {
  const cols = ['Note', 'Wishability', 'Status', 'Score', 'Count', 'ID'] as const;
  const get: Record<(typeof cols)[number], (r: FixtureRow) => string> = {
    Note: (r) => r.note, Wishability: (r) => r.wishability, Status: (r) => r.status, Score: (r) => r.score, Count: (r) => r.count, ID: (r) => r.id,
  };
  return [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(get[c](r))).join(';'))].join('\n');
}
