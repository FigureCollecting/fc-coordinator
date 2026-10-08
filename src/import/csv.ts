// CSV as MFC's export dialog writes it (import.proto ImportMfcExportRequest.csv_text): a ',' or
// ';' delimiter, fields optionally quoted with "" for a quote inside, line breaks inside quotes,
// and CRLF, LF or CR between records. Nothing here knows a column; ./rows.ts reads the header.

export interface CsvRecord {
  /** The 1-based physical line the record starts on, the header's being 1. */
  line: number;
  fields: string[];
}

/** Text that is not CSV. `line` is where the fault is. */
export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

/** ';' when the first record has more unquoted ';' than ','; otherwise ','. */
export function detectDelimiter(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/** Every record of `text`, a leading byte-order mark and blank lines dropped. */
export function parseCsv(text: string): CsvRecord[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const delimiter = detectDelimiter(body);
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let start = 1;
  let i = 0;

  const endRecord = (): void => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== '') records.push({ line: start, fields });
    fields = [];
    field = '';
  };
  /** Consume one line break at i (CRLF, LF or CR), if there is one. */
  const lineBreak = (): boolean => {
    if (body[i] === '\r') {
      i += body[i + 1] === '\n' ? 2 : 1;
    } else if (body[i] === '\n') {
      i += 1;
    } else {
      return false;
    }
    line += 1;
    return true;
  };

  while (i < body.length) {
    if (field === '' && body[i] === '"') {
      // A quoted field: up to the quote not doubled, then a delimiter, a line break or the end.
      const opened = line;
      i += 1;
      for (;;) {
        if (i >= body.length) throw new CsvError(`a quote opened on line ${opened} is never closed`, opened);
        if (body[i] === '"') {
          if (body[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        const before = i;
        if (lineBreak()) field += body.slice(before, i);
        else field += body[i++];
      }
      if (i < body.length && body[i] !== delimiter && body[i] !== '\r' && body[i] !== '\n') {
        throw new CsvError(`text after a closing quote on line ${line}`, line);
      }
    }
    if (i >= body.length) break;
    if (body[i] === delimiter) {
      fields.push(field);
      field = '';
      i += 1;
    } else if (lineBreak()) {
      endRecord();
      start = line;
    } else {
      field += body[i++];
    }
  }
  endRecord();
  return records;
}
