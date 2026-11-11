// Table files: CSV read as UTF-8, a typed header row, then one row per line, each field read as its column's type.
// The first error in the file is the one reported, naming the file and the line its row starts on.
import { tableError, show } from './errors.js';
import { isIdentifier } from './lexer.js';
import { TYPES, parseDate, parseDecimal, parseInt64 } from './values.js';

/**
 * The records of a CSV text: `{ line, fields: [{ text, quoted }] }`, `line` the line the record starts on. A broken
 * record throws `fail(line, what)`.
 */
export function* records(text, fail) {
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const start = line;
    const fields = [];
    for (;;) {
      let field;
      if (text[i] === '"') {
        let s = '';
        let j = i + 1;
        for (;;) {
          if (j >= n) fail(start, 'a quote that is never closed');
          const c = text[j];
          if (c === '"') {
            if (text[j + 1] === '"') { s += '"'; j += 2; continue; }
            break;
          }
          if (c === '\n') line++;
          s += c;
          j++;
        }
        i = j + 1;
        if (!(i >= n || text[i] === ',' || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n'))) {
          fail(start, 'something after a closing quote');
        }
        field = { text: s, quoted: true };
      } else {
        let j = i;
        while (j < n && text[j] !== ',' && text[j] !== '\n' && !(text[j] === '\r' && text[j + 1] === '\n')) j++;
        const s = text.slice(i, j);
        if (s.includes('"')) fail(start, `a quote inside a field that does not start with one: ${show(s)}`);
        i = j;
        field = { text: s, quoted: false };
      }
      fields.push(field);
      if (i < n && text[i] === ',') { i++; continue; }
      break;
    }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') { i++; line++; }
    yield { line: start, fields };
  }
}

/** A field read as a value of `type` (see values.js), or undefined when it is not one. */
export function readField(type, { text, quoted }) {
  if (text === '') return type === 'text' && quoted ? '' : null;
  switch (type) {
    case 'integer': return parseInt64(text);
    case 'decimal': return parseDecimal(text);
    case 'text': return text;
    case 'boolean': return text === 'true' ? true : text === 'false' ? false : undefined;
    case 'date': return parseDate(text);
    default: return undefined;
  }
}

/** A table file's columns from its header record, `[{ name, type }]`. */
function header(fields, fail) {
  const columns = [];
  for (const { text } of fields) {
    const m = /^([^:]*):([^:]*)$/.exec(text);
    if (!m) fail(1, `a header field that is not <column>:<type>: ${show(text)}`);
    const [, name, type] = m;
    if (!isIdentifier(name)) fail(1, `a column name that is not an identifier: ${show(name)}`);
    const lower = name.toLowerCase();
    if (!TYPES.includes(type.toLowerCase())) fail(1, `an unknown type: ${show(type)}`);
    if (columns.some((c) => c.name === lower)) fail(1, `two columns named ${lower}`);
    columns.push({ name: lower, type: type.toLowerCase() });
  }
  return columns;
}

/**
 * The table of file `<name>.csv` holding `text`: `{ name, columns, rows }`, each row an array of values. An error
 * is exit 4 with the file and the line.
 */
export function parseTable(name, text) {
  const file = `${name}.csv`;
  const fail = (line, what) => { throw tableError(`${file} line ${line}: ${what}`, { file, line }); };
  if (text.startsWith('﻿')) text = text.slice(1);
  if (text === '') fail(1, 'an empty file, with no header');
  let columns = null;
  const rows = [];
  for (const rec of records(text, fail)) {
    if (!columns) {
      columns = header(rec.fields, fail);
      continue;
    }
    if (rec.fields.length !== columns.length) {
      fail(rec.line, `${rec.fields.length} field${rec.fields.length === 1 ? '' : 's'} where the header has ${columns.length}`);
    }
    rows.push(rec.fields.map((f, k) => {
      const v = readField(columns[k].type, f);
      if (v === undefined) fail(rec.line, `bad ${columns[k].type} ${show(f.text)}`);
      return v;
    }));
  }
  return { name, columns, rows };
}

/** A printed value as a CSV field: wrapped in quotes, each `"` doubled, when it holds a comma, a quote, `\r` or `\n`. */
export const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
