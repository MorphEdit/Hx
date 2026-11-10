// CSV in and out.
//
// Out: a field that holds a comma, a double quote or a line break is wrapped in double quotes, each double quote
// inside doubled; every other field is written as it is. Every row ends with `\n`.
//
// In: a field may be wrapped in double quotes, and may then hold commas, doubled double quotes and line breaks. Rows
// end with LF or CRLF. Blank lines are skipped. A quote that is never closed, or text after a closing quote before the
// next comma or line end, is an error.

const NEEDS_QUOTES = /[",\r\n]/;

/** One field as CSV. */
export function csvField(value) {
  const text = String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The CSV text of a list of rows, each a list of strings: every row ending with `\n`. */
export function toCsv(rows) {
  return rows.map((row) => `${row.map(csvField).join(',')}\n`).join('');
}

/** A CSV error: the line the row it is in starts on, and what is wrong. */
export class CsvError extends Error {
  constructor(line, what) {
    super(`line ${line}: ${what}`);
    this.name = 'CsvError';
    this.line = line;
    this.what = what;
  }
}

/** Whether a row is a blank line: one field, not quoted, holding only whitespace. */
function isBlankRow(fields, quoted) {
  return fields.length === 1 && !quoted[0] && /^[ \t]*$/.test(fields[0]);
}

/**
 * The rows of a CSV text, each { line, fields }, `line` the line the row starts on. Blank lines are skipped. Throws a
 * CsvError for a quote that is never closed or text after a closing quote.
 */
export function readCsvRows(text) {
  const rows = [];
  let i = 0;
  let line = 1;
  const atRowEnd = () => i >= text.length || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n');
  const skipRowEnd = () => {
    if (text[i] === '\r') {
      i += 2;
    } else if (text[i] === '\n') {
      i += 1;
    }
    line += 1;
  };
  while (i < text.length) {
    const start = line;
    const fields = [];
    const quoted = [];
    for (;;) {
      if (text[i] === '"') {
        // a quoted field: up to the closing quote, a doubled quote standing for one
        let value = '';
        i += 1;
        for (;;) {
          if (i >= text.length) {
            throw new CsvError(start, 'a quote is never closed');
          }
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          if (c === '\n') {
            line += 1;
          }
          value += c;
          i += 1;
        }
        if (!atRowEnd() && text[i] !== ',') {
          throw new CsvError(start, 'text after a closing quote');
        }
        fields.push(value);
        quoted.push(true);
      } else {
        let value = '';
        while (!atRowEnd() && text[i] !== ',') {
          value += text[i];
          i += 1;
        }
        fields.push(value);
        quoted.push(false);
      }
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      break;
    }
    if (!isBlankRow(fields, quoted)) {
      rows.push({ line: start, fields });
    }
    if (i < text.length) {
      skipRowEnd();
    }
  }
  return rows;
}

/** The rows of a CSV text, each a list of strings, blank lines skipped. Throws on bad quoting. */
export function parseCsv(text) {
  return readCsvRows(text).map((row) => row.fields);
}
