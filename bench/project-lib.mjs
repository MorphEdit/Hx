// The project benchmark's pure parts (bench/project.mjs holds the I/O): the caps, escaped defects, the repo
// setup step and the result fields. Importing this module creates no repo and spawns nothing.
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutcomes } from '../src/outcomes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = path.join(here, 'project', 'template');

/** `'stop'` once the run is at or past either cap, `'continue'` before. */
export function capCheck({ elapsedMs, costUsd, maxHours, maxUsd }) {
  return elapsedMs >= maxHours * 3_600_000 || costUsd >= maxUsd ? 'stop' : 'continue';
}

/** The hidden failures of a run that claimed done; `null` for a capped or early run (unfinished, not escaped). */
export function escapedDefects(failed, ended) {
  return ended === 'done' ? failed : null;
}

/** The repo setup step: `template/` into `dir`, then a git repo on `main` with one commit. Nothing else is copied. */
export function setupRepo(dir, { template = TEMPLATE } = {}) {
  cpSync(template, dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'tally: empty project');
}

/** Distinct `sessionId`s per `role` over usage records. */
export function sessionsByRole(records) {
  const by = {};
  for (const r of records) (by[r.role] ??= new Set()).add(r.sessionId);
  return Object.fromEntries(Object.entries(by).map(([role, s]) => [role, s.size]));
}

/** Token sums (input, cacheWrite, cacheRead, output, total) and the cost over usage records. */
export function usageTotals(records) {
  const sum = (k) => records.reduce((a, r) => a + (r.usage?.[k] ?? 0), 0);
  const tokens = { input: sum('input'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'), output: sum('output') };
  tokens.total = tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
  return { tokens, costUsd: records.reduce((a, r) => a + (r.costUsd ?? 0), 0) };
}

/** The `audit FAIL ✗` lines of run.log, counted as the dashboard counts them. */
export function auditFails(runLog) {
  return parseOutcomes(runLog.split(/\r?\n/)).audit.fail;
}

/** The lines of gate-runs.jsonl with `ok: false`; malformed lines are skipped. */
export function gateReds(gateRunsJsonl) {
  let n = 0;
  for (const l of gateRunsJsonl.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { if (JSON.parse(l).ok === false) n++; } catch { /* a torn line */ }
  }
  return n;
}

/** The JSON lines of a usage.jsonl text; malformed lines are skipped. */
export function parseJsonl(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn line */ }
  }
  return out;
}
