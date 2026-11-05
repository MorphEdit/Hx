// Shared by the hidden cases: the checkout under test is TALLY_CHECKOUT (set by bench/project-grade.mjs).
// Its package.json `main` is the library and `bin.tally` the CLI; a missing or broken entry fails the case
// that needs it, never the whole run.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.env.TALLY_CHECKOUT ?? '.');

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

/** A fresh temp log path, holding `content` when given. */
export function tmpLog(content) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tally-')), 'tally.log');
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

export const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

const CLI_TIMEOUT_MS = 180_000;

/** Run the CLI: `node <bin.tally> ...args` with TALLY_NOW and TALLY_LOG set. */
export async function tally(args, { now = '2024-03-04T09:00', log } = {}) {
  const p = pkg();
  const bin = entry(typeof p.bin === 'string' ? p.bin : p.bin?.tally, 'bin.tally');
  const env = { ...process.env, TALLY_NOW: now, TALLY_LOG: log ?? tmpLog() };
  for (const k of Object.keys(env)) if (/^NODE_(TEST|OPTIONS)/.test(k)) delete env[k];
  // the timeout only stops a CLI that hangs: the cases run side by side, and under a loaded `npm test` a node start
  // takes tens of seconds, so it is far above that (#285); a CLI killed by it fails the case, never passes as an exit code
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.killed) reject(new Error(`the CLI did not finish within ${CLI_TIMEOUT_MS / 1000} s`));
      else if (err && typeof err.code !== 'number') reject(err);
      else resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
  // Node ends an uncaught error (a syntax error, a missing import, a throw) with its version line: that is a
  // CLI that crashed, never the error message a case expects, so every case that runs it fails
  if (/^Node\.js v\d/m.test(stderr)) throw new Error(`the CLI crashed (exit ${code}):\n${stderr}`);
  return { code, stdout, stderr, out: stdout.replace(/\r?\n$/, '') };
}
