// Shared by the hidden cases: the checkout under test is LEDGE_CHECKOUT (set by bench/project-grade.mjs from the
// fixture's manifest). Its package.json `main` is the library and `bin.ledge` the CLI; a missing or broken entry fails
// the case that needs it, never the whole run. Every case runs in a fresh temp folder of its own.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.env.LEDGE_CHECKOUT ?? '.');

function pkg() {
  return JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'));
}

function entry(rel, what) {
  if (typeof rel !== 'string' || !rel) throw new Error(`package.json has no ${what} entry`);
  const file = path.resolve(checkout, rel);
  if (!existsSync(file)) throw new Error(`${what} ${rel} does not exist`);
  return file;
}

/** The library, imported from package.json `main`. */
export async function loadLib() {
  return import(pathToFileURL(entry(pkg().main, 'main')).href);
}

/** A fresh temp folder holding `files` (relative name → text or Buffer). */
export function workdir(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledge-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

/** A file of a folder as text, or null when it does not exist. */
export const read = (dir, name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : null);

/** Lines joined into a file's text, each ending with `\n`. */
export const lines = (...ls) => ls.map((l) => `${l}\n`).join('');

const CLI_TIMEOUT_MS = 180_000;

/**
 * Run the CLI: `node <bin.ledge> ...args` in `dir`, with LEDGE_TODAY = `today` and LEDGE_FILE = `file` (relative to
 * `dir`). `today: null` or `file: null` leaves that variable unset. `journal` (text) is written to `file` first.
 */
export async function ledge(args, { dir = workdir(), today = '2024-03-15', file = 'ledger.journal', journal, env: extra = {} } = {}) {
  const p = pkg();
  const bin = entry(typeof p.bin === 'string' ? p.bin : p.bin?.ledge, 'bin.ledge');
  if (journal !== undefined) writeFileSync(path.join(dir, file ?? 'ledger.journal'), journal);
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^NODE_(TEST|OPTIONS)/.test(k) || /^LEDGE_(TODAY|FILE)$/.test(k)) delete env[k];
  if (today !== null) env.LEDGE_TODAY = today;
  if (file !== null) env.LEDGE_FILE = file;
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

/** A success with exactly this stdout (lines, each ending with `\n`). */
export function ok(r, ...out) {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, lines(...out));
}

/** A failure with this exit code: stderr holds a message, stdout is empty. */
export function fails(r, code) {
  assert.equal(r.code, code, `exit ${r.code}, stdout: ${r.stdout}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, '', 'errors go to stderr only');
  assert.notEqual(r.stderr.trim(), '', 'an error message on stderr');
}

/** A failure with this exit code whose message names the file and `line N`. */
export function failsAt(r, code, file, line) {
  fails(r, code);
  assert.ok(r.stderr.includes(file), `the message names ${file}: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`\\bline ${line}\\b`), `the message has line ${line}: ${r.stderr}`);
}

/** The accounts every query case declares. */
export const ACCOUNTS = [
  'account Assets:Bank', 'account Assets:Cash', 'account Expenses:Food', 'account Expenses:Food:Coffee',
  'account Expenses:Rent', 'account Income:Salary', 'account Liabilities:Card', 'account Equity:Opening',
];

/** The journal most query cases read: two currencies, an inferred amount, one transaction out of date order. */
export const BOOK = lines(
  ...ACCOUNTS,
  '',
  '2024-01-01 Opening balance',
  '    Assets:Bank  1000.00 USD',
  '    Equity:Opening',
  '',
  '2024-01-05 Corner Shop',
  '    Expenses:Food  42.10 USD',
  '    Assets:Bank',
  '',
  '2024-01-31 ACME Ltd',
  '    Assets:Bank  3000.00 USD',
  '    Income:Salary  -3000.00 USD',
  '',
  '2024-02-01 Landlord',
  '    Expenses:Rent  1200.00 USD',
  '    Assets:Bank  -1200.00 USD',
  '',
  '2024-02-03 Cafe Bleu',
  '    Expenses:Food:Coffee  4.50 EUR',
  '    Liabilities:Card  -4.50 EUR',
  '',
  '2024-01-20 corner shop',
  '    Expenses:Food  10.00 USD',
  '    Assets:Cash  -10.00 USD',
  '',
  '2024-04-02 ACME Ltd',
  '    Assets:Bank  3000.00 USD',
  '    Income:Salary',
);
