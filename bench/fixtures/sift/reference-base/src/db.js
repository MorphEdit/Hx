// The data directory and the tables a run of statements sees. A Session reads a table file only when a statement
// names it, once per run; what statements change is kept in the session (`overlay`) and written only when the whole
// run has succeeded (`commit`, by the writes module), so a failing statement leaves every file as it was.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { envError, tableError } from './errors.js';
import { parseTable } from './csv.js';
import { RESERVED } from './lexer.js';

const TABLE_FILE = /^([a-z_][a-z0-9_]*)\.csv$/;

/** The data directory as an absolute path, or exit 2 when it is not an existing directory. */
export function dataDir(db) {
  if (typeof db !== 'string' || db === '') throw envError('no data directory: SIFT_DB is not set');
  const dir = path.resolve(db);
  let st;
  try { st = statSync(dir); } catch { st = null; }
  if (!st || !st.isDirectory()) throw envError(`the data directory ${JSON.stringify(db)} does not exist`);
  return dir;
}

/** The table names in a data directory, sorted, from its listing alone: no file is read. */
export function listTables(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { throw envError(`cannot list the data directory ${JSON.stringify(dir)}`); }
  const names = [];
  for (const e of entries) {
    const m = TABLE_FILE.exec(e.name);
    if (m && !RESERVED.has(m[1]) && e.isFile()) names.push(m[1]);
  }
  return names.sort();
}

export class Session {
  /** @param {string} dir the data directory, absolute */
  constructor(dir) {
    this.dir = dir;
    this.files = new Set(listTables(dir));
    /** Tables read from their files: name → table. */
    this.read = new Map();
    /** What statements of this run changed: name → table, or null for a dropped table. */
    this.overlay = new Map();
  }

  exists(name) {
    if (this.overlay.has(name)) return this.overlay.get(name) !== null;
    return this.files.has(name);
  }

  /** A table by name: what this run left of it, else its file, read once. Exit 4 when it does not exist or is broken. */
  table(name) {
    if (this.overlay.has(name)) {
      const t = this.overlay.get(name);
      if (t) return t;
    } else if (this.files.has(name)) {
      if (!this.read.has(name)) {
        let text;
        try { text = readFileSync(path.join(this.dir, `${name}.csv`), 'utf8'); } catch {
          throw tableError(`${name}.csv cannot be read`, { file: `${name}.csv`, line: 1 });
        }
        this.read.set(name, parseTable(name, text));
      }
      return this.read.get(name);
    }
    throw tableError(`no such table: ${name}`);
  }

  /** A table that this run changed or created. */
  set(name, table) { this.overlay.set(name, table); }

  /** A table that this run dropped. */
  drop(name) { this.overlay.set(name, null); }
}
