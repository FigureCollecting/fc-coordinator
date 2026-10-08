import { describe, expect, it } from 'vitest';
import { ExportError, readExport, type ExportRow } from './rows.js';

const MFC_HEADER =
  '"ID","Title","Root","Category","Release Date","Price","Scale","Barcode","Status","Count","Score","Payment date","Shipping date","Collecting date","Price","Shop","Shipping method","Tracking number","Wishability","Note"';

/** One MFC row with every column quoted, as the export dialog writes it. */
function mfcLine(id: string, status: string, count = '1', score = '', wish = '0', note = ''): string {
  const cells = [id, 'Some figure', 'Figures', 'Prepainted', '2026-03-01', '12800', '1/7', '4573102591234', status, count, score, '', '', '', '9800', '', '', '', wish, note];
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
}

const pick = (rows: ExportRow[]) => rows.map((r) => ({ line: r.line, id: r.id, kind: r.kind, count: r.count, fields: r.fields, reason: r.reason }));

describe('readExport', () => {
  it("reads MFC's own export: twenty quoted columns, Price twice, CRLF", () => {
    const text = [MFC_HEADER, mfcLine('119', 'Owned', '2', '10/10', '0', 'boxed'), mfcLine('3743689', 'Wished', '1', '', '5')].join('\r\n') + '\r\n';
    expect(pick(readExport(text))).toEqual([
      { line: 2, id: '119', kind: 'owned', count: 2, fields: { score: 10, note: 'boxed' }, reason: undefined },
      { line: 3, id: '3743689', kind: 'wished', count: 1, fields: { wishability: 5 }, reason: undefined },
    ]);
  });

  it('parses reordered columns with a ";" delimiter exactly as the comma export', () => {
    const comma = [MFC_HEADER, mfcLine('119', 'Owned', '2', '7/10', '0', 'a; b, "c"'), mfcLine('120', 'Ordered')].join('\r\n');
    const semi = ['Note;Wishability;Score;Count;Status;ID', '"a; b, ""c""";0;7/10;2;Owned;119', ';0;;1;Ordered;120'].join('\n');
    expect(pick(readExport(semi))).toEqual(pick(readExport(comma)));
  });

  it('finds columns by header name, ignoring case and surrounding spaces', () => {
    expect(pick(readExport(' id ,STATUS\n5,owned\n'))).toEqual([{ line: 2, id: '5', kind: 'owned', count: 1, fields: {}, reason: undefined }]);
  });

  it('refuses an export with no ID column, naming it', () => {
    expect(() => readExport('Title,Status\nx,Owned\n')).toThrow(ExportError);
    expect(() => readExport('Title,Status\nx,Owned\n')).toThrow(/"ID"/);
    expect(() => readExport('Title\nx\n')).toThrow(/"ID"/);
  });

  it('refuses an export with no Status column, naming it', () => {
    expect(() => readExport('ID,Title\n1,x\n')).toThrow(/"Status"/);
  });

  it('refuses an empty export, naming the ID column', () => {
    expect(() => readExport('')).toThrow(/"ID"/);
  });

  it('refuses malformed CSV as an export error with its line', () => {
    expect(() => readExport('ID,Status\n1,"Owned\n')).toThrow(ExportError);
    expect(() => readExport('ID,Status\n1,"Owned\n')).toThrow(/line 2/);
  });

  it('gives each row the first reason that applies: invalid_id, duplicate_id, invalid_count, count_over_99', () => {
    const text = [
      'ID,Status,Count',
      '1144,Owned,',
      '01144,Owned,1', // the same canonical id: the first row stands
      '0,Owned,1',
      '+12,Owned,1',
      ' 12,Owned,1',
      '１２,Owned,1', // full-width digits are no MFC id
      ',Owned,1',
      '0,Owned,x', // invalid_id before invalid_count
      '01144,Owned,x', // duplicate_id before invalid_count
      '13,Owned,1.5',
      '14,Owned,-1',
      '15,Owned,100',
      '16,Wished,099',
      '17,Wished,0',
      '18,Wished,  ',
      '13,Owned,1', // a row unresolved for its Count still claims its id
    ].join('\n');
    expect(readExport(text).map((r) => [r.line, r.id, r.count, r.reason ?? 'ok'])).toEqual([
      [2, '1144', 1, 'ok'],
      [3, '1144', 1, 'duplicate_id'],
      [4, null, 1, 'invalid_id'],
      [5, null, 1, 'invalid_id'],
      [6, null, 1, 'invalid_id'],
      [7, null, 1, 'invalid_id'],
      [8, null, 1, 'invalid_id'],
      [9, null, null, 'invalid_id'],
      [10, '1144', null, 'duplicate_id'],
      [11, '13', null, 'invalid_count'],
      [12, '14', null, 'invalid_count'],
      [13, '15', 100, 'count_over_99'],
      [14, '16', 99, 'ok'],
      [15, '17', 0, 'ok'],
      [16, '18', 1, 'ok'],
      [17, '13', 1, 'duplicate_id'],
    ]);
  });

  it('keeps the ID and Status as they appear, for the unresolved list', () => {
    const [row] = readExport('ID,Status\n007,Owned\n');
    expect(row).toMatchObject({ rawId: '007', rawStatus: 'Owned', id: '7' });
  });

  it('maps Owned, Ordered and Wished, in any case, and refuses any other Status naming its line', () => {
    expect(readExport('ID,Status\n1, Owned \n2,ORDERED\n3,wished\n').map((r) => r.kind)).toEqual(['owned', 'ordered', 'wished']);
    expect(() => readExport('ID,Status\n1,Owned\n2,Sold\n')).toThrow(/line 3.*Status/);
    expect(() => readExport('ID,Status\n1,\n')).toThrow(/line 2.*Status/);
  });

  it('reads a score "N/10", treats blank and 0/10 as none, and refuses anything else naming the line', () => {
    const text = 'ID,Status,Score\n1,Owned,7/10\n2,Owned,\n3,Owned,0/10\n4,Owned,10/10\n5,Owned, 1/10 \n';
    expect(readExport(text).map((r) => r.fields.score)).toEqual([7, undefined, undefined, 10, 1]);
    for (const bad of ['11/10', '7', '7/5', 'x/10', '-1/10', '7.5/10']) {
      expect(() => readExport(`ID,Status,Score\n1,Owned,${bad}\n`)).toThrow(/line 2.*Score/);
    }
  });

  it('treats a Score or Wishability cell of spaces alone as blank: no value, no refusal', () => {
    expect(readExport('ID,Status,Score,Wishability\n1,Owned,  ,\n2,Wished,, \n').map((r) => [r.fields, r.reason])).toEqual([
      [{}, undefined],
      [{}, undefined],
    ]);
  });

  it('reads wishability 1 to 5, treats blank and 0 as none, and refuses anything else naming the line', () => {
    expect(readExport('ID,Status,Wishability\n1,Wished,3\n2,Wished,0\n3,Wished,\n4,Wished,5\n').map((r) => r.fields.wishability)).toEqual([
      3,
      undefined,
      undefined,
      5,
    ]);
    for (const bad of ['6', 'x', '2.5', '-1']) expect(() => readExport(`ID,Status,Wishability\n1,Wished,${bad}\n`)).toThrow(/line 2.*Wishability/);
  });

  it('keeps a note verbatim, treats a blank one as none, and refuses one over 10,000 code points', () => {
    const astral = '\u{1F600}'.repeat(10_000);
    const rows = readExport(`ID,Status,Note\n1,Owned," keep  me "\n2,Owned,"  \t "\n3,Owned,"${astral}"\n`);
    expect(rows.map((r) => r.fields.note)).toEqual([' keep  me ', undefined, astral]);
    expect(() => readExport(`ID,Status,Note\n1,Owned,"${'x'.repeat(10_001)}"\n`)).toThrow(/line 2.*Note/);
  });

  it('reads a short record as blanks and ignores cells past the header', () => {
    expect(pick(readExport('ID,Status,Count,Score\n1,Owned\n2,Wished,2,,extra\n'))).toEqual([
      { line: 2, id: '1', kind: 'owned', count: 1, fields: {}, reason: undefined },
      { line: 3, id: '2', kind: 'wished', count: 2, fields: {}, reason: undefined },
    ]);
  });
});
