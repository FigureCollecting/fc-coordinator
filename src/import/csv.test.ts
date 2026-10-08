import { describe, expect, it } from 'vitest';
import { CsvError, detectDelimiter, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads quoted fields with the delimiter, "" escapes and line breaks inside them', () => {
    const text = '"ID","Note"\r\n"1","a, b; ""c""\r\nsecond line"\r\n"2",plain\r\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, fields: ['ID', 'Note'] },
      { line: 2, fields: ['1', 'a, b; "c"\r\nsecond line'] },
      { line: 4, fields: ['2', 'plain'] },
    ]);
  });

  it('numbers each record by the physical line it starts on, whatever ends the lines', () => {
    expect(parseCsv('a\nb\rc\r\nd').map((r) => [r.line, r.fields[0]])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [4, 'd'],
    ]);
  });

  it('drops a byte-order mark and blank lines, and keeps empty fields', () => {
    expect(parseCsv('﻿ID;Status\n\n1;;\n\r\n')).toEqual([
      { line: 1, fields: ['ID', 'Status'] },
      { line: 3, fields: ['1', '', ''] },
    ]);
  });

  it('splits on ";" when the header has more of them than commas', () => {
    expect(detectDelimiter('"ID";"Title, long";"Status"\r\n1;2;3')).toBe(';');
    expect(detectDelimiter('ID,Status;x\n')).toBe(',');
    expect(detectDelimiter('ID\n')).toBe(',');
    // Only the header is counted: the rows' own punctuation does not choose.
    expect(detectDelimiter('ID,Status\n1;2;3;4\n')).toBe(',');
    expect(detectDelimiter('ID;Status\r1,2,3,4\r')).toBe(';');
    expect(parseCsv('"ID";"Title, long";"Status"\r\n"7";"x, y";Owned')).toEqual([
      { line: 1, fields: ['ID', 'Title, long', 'Status'] },
      { line: 2, fields: ['7', 'x, y', 'Owned'] },
    ]);
  });

  it('ignores a quoted delimiter when it counts the header, and a ";" inside a comma file', () => {
    expect(detectDelimiter('"a;b;c",d\n')).toBe(',');
    expect(parseCsv('ID,Note\n1,"x;y"\n')[1]!.fields).toEqual(['1', 'x;y']);
  });

  it('refuses a quote that is never closed, naming the line it opened on', () => {
    const run = () => parseCsv('ID,Note\n1,ok\n2,"never\nclosed\n');
    expect(run).toThrow(CsvError);
    expect(run).toThrow(/line 3/);
  });

  it('refuses text after a closing quote, naming its line', () => {
    expect(() => parseCsv('ID,Note\n1,"x"y\n')).toThrow(/line 2/);
  });

  it('reads a quote in the middle of an unquoted field as text', () => {
    expect(parseCsv('a,b"c\n')[0]!.fields).toEqual(['a', 'b"c']);
  });
});
