// The output formats: table, csv, json and markdown, from a result of `query` (the library's values).
import { csvField } from './csv.js';

export const FORMATS = ['table', 'csv', 'json', 'markdown'];

/** A column of numbers (integer or decimal): right-aligned in the table format, marked `---:` in markdown. */
const isNumberColumn = (types, k) => types?.[k] === 'integer' || types?.[k] === 'decimal';

/** A library value as sift prints it; NULL as null. */
function printed(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function table({ columns, types, rows }) {
  const cells = rows.map((r) => r.map((v) => {
    const s = printed(v);
    return s === null ? 'NULL' : s.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }));
  const widths = columns.map((name, k) => Math.max(name.length, ...cells.map((r) => r[k].length)));
  const line = (vals) => vals.map((s, k) => (isNumberColumn(types, k) ? s.padStart(widths[k]) : s.padEnd(widths[k]))).join(' | ').replace(/ +$/, '');
  const out = [line(columns), widths.map((w) => '-'.repeat(w)).join('-+-'), ...cells.map(line)];
  out.push(`(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`);
  return out.map((l) => `${l}\n`).join('');
}

function csv({ columns, rows }) {
  const out = [columns.map(csvField).join(',')];
  for (const r of rows) {
    out.push(r.map((v) => {
      const s = printed(v);
      if (s === null) return '';
      return s === '' ? '""' : csvField(s);
    }).join(','));
  }
  return out.map((l) => `${l}\n`).join('');
}

function json({ columns, types, rows }) {
  const value = (v, k) => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'bigint' || types?.[k] === 'integer' || types?.[k] === 'decimal') return String(v);
    return JSON.stringify(v);
  };
  return `{"columns":${JSON.stringify(columns)},"rows":[${rows.map((r) => `[${r.map(value).join(',')}]`).join(',')}]}\n`;
}

function markdown({ columns, types, rows }) {
  const cell = (v) => {
    const s = printed(v);
    if (s === null) return 'NULL';
    return s.replace(/\|/g, '\\|').replace(/\r\n|\n|\r/g, '<br>');
  };
  const line = (cells) => `| ${cells.join(' | ')} |\n`;
  return line(columns) + line(columns.map((_, k) => (isNumberColumn(types, k) ? '---:' : '---'))) + rows.map((r) => line(r.map(cell))).join('');
}

/** The text sift prints for a result: a SELECT's rows in format `name`, or a message and a line break. */
export function format(result, name = 'table') {
  if (result && typeof result.message === 'string') return `${result.message}\n`;
  if (name === 'csv') return csv(result);
  if (name === 'json') return json(result);
  if (name === 'markdown') return markdown(result);
  return table(result);
}
