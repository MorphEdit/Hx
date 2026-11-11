// The library: query, run, format, tables and SiftError, as the brief's "Using it from Node" states them. It never
// reads the environment: the data directory and today are options.
import { SiftError, envError } from './errors.js';
import { Session, dataDir, listTables } from './db.js';
import { execute } from './engine.js';
import { parseScript, parseStatement } from './parser.js';
import { localToday, parseDate } from './values.js';
import { commit } from './writes.js';

export { SiftError };
export { format } from './format.js';

/** Today from a `YYYY-MM-DD` text, the local date when it is undefined; exit 2 when it is not a real date. */
export function todayFrom(text) {
  if (text === undefined) return localToday();
  const d = typeof text === 'string' ? parseDate(text) : undefined;
  if (d === undefined) throw envError(`today is not a real date: ${JSON.stringify(String(text))}`);
  return d;
}

/** The environment of a run: the data directory checked, then a session over it. */
function open(options = {}) {
  const today = todayFrom(options.today);
  const dir = dataDir(options.db);
  return { dir, today };
}

/** Statements run in order in one session; the changed tables written only when every one has succeeded. */
export function runStatements(stmts, { dir, today }) {
  const session = new Session(dir);
  const results = stmts.map((s) => execute(s, { session, today }));
  commit(session);
  return results;
}

/** One statement, like `sift query`. */
export function query(sql, options) {
  const env = open(options);
  return runStatements([parseStatement(String(sql))], env)[0];
}

/** A script's text, all or nothing, like `sift run`: the list of the statements' results. */
export function run(script, options) {
  const env = open(options);
  return runStatements(parseScript(String(script)), env);
}

/** The table names of a data directory, sorted, like `sift tables`. */
export function tables(db) {
  return listTables(dataDir(db));
}
