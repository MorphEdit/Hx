// The errors sift reports. Each carries the exit code the brief gives its kind, so the command line turns any of them
// into one `error: ` line on stderr and that exit code without knowing where it came from.
//
// The brief's precedence list is the order sift meets them in:
//   1 usage, 2 environment, 3 syntax, 4 tables, 5 checks, 6 run time.

export const EXIT = { usage: 1, environment: 2, syntax: 3, table: 4, check: 5, runtime: 6 };

/** Every error sift reports on purpose: `exitCode`, the message after `error: `, and where it was found. */
export class SiftError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} message
   * @param {{ line?: number, column?: number, file?: string }} [where]
   */
  constructor(exitCode, message, where = {}) {
    super(oneLine(message));
    this.name = 'SiftError';
    this.exitCode = exitCode;
    if (where.line !== undefined) this.line = where.line;
    if (where.column !== undefined) this.column = where.column;
    if (where.file !== undefined) this.file = where.file;
  }
}

/** A message is one line: line breaks a value brought in are shown escaped. */
const oneLine = (s) => String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n');

export const usageError = (msg) => new SiftError(EXIT.usage, msg);
export const envError = (msg) => new SiftError(EXIT.environment, msg);
export const tableError = (msg, where) => new SiftError(EXIT.table, msg, where);
export const checkError = (msg) => new SiftError(EXIT.check, msg);
export const runtimeError = (msg) => new SiftError(EXIT.runtime, msg);

/** A syntax error at a line and column. */
export const syntaxError = (line, column, what) =>
  new SiftError(EXIT.syntax, `syntax error at line ${line}, column ${column}: ${what}`, { line, column });

/** A value quoted for a message. */
export const show = (v) => JSON.stringify(String(v));
