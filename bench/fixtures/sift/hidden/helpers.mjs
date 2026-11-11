// Shared by the hidden cases: the checkout under test is SIFT_CHECKOUT (set by bench/project-grade.mjs from the
// fixture's manifest), and nothing else names it. Its package.json `main` is the library and `bin.sift` the CLI; a
// missing or broken entry fails the case that needs it, never the whole run. Every case runs in a fresh temp folder
// of its own, with its data directory `db/` in it.
//
// The tags: a case written `change(name, fn)` checks behaviour the change (change.md) adds or alters, so a build of
// the brief alone fails it; a case written `test(name, fn)` expects the same with or without the change. tags.json
// holds the same split by case name.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/** A case of behaviour the change adds or alters (tagged `change` in tags.json): `test` itself, so the case is reported from its own file. */
export const change = test;

function checkout() {
  const dir = process.env.SIFT_CHECKOUT;
  if (!dir) throw new Error('SIFT_CHECKOUT is not set');
  return path.resolve(dir);
}

function pkg() {
  return JSON.parse(readFileSync(path.join(checkout(), 'package.json'), 'utf8'));
}

function entry(rel, what) {
  if (typeof rel !== 'string' || !rel) throw new Error(`package.json has no ${what} entry`);
  const file = path.resolve(checkout(), rel);
  if (!existsSync(file)) throw new Error(`${what} ${rel} does not exist`);
  return file;
}

/** The library, imported from package.json `main`. */
export async function loadLib() {
  return import(pathToFileURL(entry(pkg().main, 'main')).href);
}

/** Lines joined into a file's text, each ending with `\n`. */
export const lines = (...ls) => ls.map((l) => `${l}\n`).join('');

/**
 * A fresh temp folder with an empty data directory `db/`, holding `tables` (name → the text of db/<name>.csv) and
 * `files` (a path relative to the folder → text or Buffer).
 */
export function workdir({ tables = {}, files = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sift-'));
  mkdirSync(path.join(dir, 'db'));
  const all = { ...Object.fromEntries(Object.entries(tables).map(([name, body]) => [`db/${name}.csv`, body])), ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

/** A file of a folder as text, or null when it does not exist. */
export const read = (dir, name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : null);

/** The names in the data directory, sorted. */
export const dbFiles = (dir) => readdirSync(path.join(dir, 'db')).sort();

/** The data directory's path, for the library. */
export const dbPath = (dir) => path.join(dir, 'db');

const CLI_TIMEOUT_MS = 180_000;

/**
 * Run the CLI: `node <bin.sift> ...args` in `dir`, with SIFT_DB = `db` (relative to `dir`) and SIFT_TODAY = `today`.
 * `db: null` or `today: null` leaves that variable unset. Without `dir`, a new workdir of `tables` and `files`.
 */
export async function sift(args, { dir, tables, files, db = 'db', today = '2024-03-15', env: extra = {} } = {}) {
  const p = pkg();
  const bin = entry(typeof p.bin === 'string' ? p.bin : p.bin?.sift, 'bin.sift');
  dir ??= workdir({ tables, files });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_(TEST|OPTIONS)/.test(k) || /^SIFT_/.test(k)) delete env[k];
  if (db !== null) env.SIFT_DB = db;
  if (today !== null) env.SIFT_TODAY = today;
  Object.assign(env, extra);
  // the timeout only stops a CLI that hangs: the cases run side by side, and under a loaded `npm test` a node start
  // takes tens of seconds, so it is far above that; a CLI killed by it fails the case, never passes as an exit code
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { cwd: dir, env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.killed) reject(new Error(`the CLI did not finish within ${CLI_TIMEOUT_MS / 1000} s`));
      else if (err && typeof err.code !== 'number') reject(err);
      else resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  // Node ends an uncaught error with its version line: that is a CLI that crashed, never an error message
  if (/^Node\.js v\d/m.test(stderr)) throw new Error(`the CLI crashed (exit ${code}):\n${stderr}`);
  return { code, stdout, stderr, dir };
}

/** `sift query <sql>`, with `--format <format>` when given. */
export const query = (sql, { format, ...opts } = {}) => sift(['query', sql, ...(format ? ['--format', format] : [])], opts);

/** `sift query <sql> --format csv`. */
export const csv = (sql, opts = {}) => query(sql, { ...opts, format: 'csv' });

/** `sift run <script.sql>` over a script written to the folder first, with `--format <format>` when given. */
export function script(text, { format, tables, files = {}, ...opts } = {}) {
  const dir = opts.dir ?? workdir({ tables, files: { ...files, 'script.sql': text } });
  if (opts.dir) writeFileSync(path.join(dir, 'script.sql'), text);
  return sift(['run', 'script.sql', ...(format ? ['--format', format] : [])], { ...opts, dir });
}

/** A success with exactly this stdout (lines, each ending with `\n`). */
export function ok(r, ...out) {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, lines(...out));
}

/** A failure with this exit code: one `error: ` line on stderr, stdout empty. */
export function fails(r, code) {
  assert.equal(r.code, code, `exit ${r.code}, stdout: ${r.stdout}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, '', 'errors go to stderr only');
  assert.match(r.stderr, /^error: [^\n]*\S[^\n]*\n$/, `one error line on stderr: ${JSON.stringify(r.stderr)}`);
}

/** A syntax error (exit 3) at line L, column C. */
export function syntaxAt(r, line, column) {
  fails(r, 3);
  assert.match(r.stderr, new RegExp(`^error: syntax error at line ${line}, column ${column}: `), r.stderr);
}

/** A table file error (exit 4) naming the file and `line N`. */
export function fileErrorAt(r, file, line) {
  fails(r, 4);
  assert.ok(r.stderr.includes(file), `the message names ${file}: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`\\bline ${line}\\b`), `the message has line ${line}: ${r.stderr}`);
}

/** Today's local date, YYYY-MM-DD. */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The fruit table of the brief, with a row of NULLs. */
export const FRUIT = lines(
  'id:integer,name:text,price:decimal,in_stock:boolean,added:date',
  '1,apple,1.5,true,2024-01-05',
  '2,"pear, green",0.25,false,',
  '3,"",12,true,2023-12-31',
  '4,,,,',
);

/** Customers and their orders: one order of no known customer, one with a NULL customer. */
export const CUSTOMERS = lines(
  'id:integer,name:text,city:text',
  '1,Ann,Oslo',
  '2,Bob,Rome',
  '3,Cy,',
  '4,Dee,Oslo',
);

export const ORDERS = lines(
  'id:integer,customer_id:integer,amount:decimal,placed:date',
  '10,1,20.5,2024-01-02',
  '11,2,5,2024-01-03',
  '12,1,7.25,2024-02-10',
  '13,9,1,2024-02-11',
  '14,,3.5,2024-03-01',
);

/** Sales, for grouping: NULLs in every column but `product`. */
export const SALES = lines(
  'region:text,product:text,qty:integer,price:decimal,day:date',
  'north,apple,3,1.5,2024-01-02',
  'south,pear,,2.0,2024-01-03',
  'north,pear,2,,2024-01-03',
  'east,apple,5,1.25,2024-02-01',
  'south,apple,1,1.5,',
  ',kiwi,4,0.5,2024-02-10',
);
