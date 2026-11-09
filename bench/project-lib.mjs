// The project benchmark's pure parts (bench/project.mjs holds the I/O): the arguments, the caps, escaped defects, the
// repo setup step, the result fields and the provenance's roles. Importing this module creates no repo and spawns nothing.
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, ROLES, roleModel, workerArgs } from '../src/config.ts';
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

export const USAGE = 'usage: node bench/project.mjs <chat|hx3> [--runs N] [--max-hours 4] [--max-usd 60] [--config key=value ...]';

/** The CLI's arguments: `{ arm, runs, maxHours, maxUsd }`, or null for the usage line (an unknown arm, `--runs` not a
 *  positive integer, a cap not a positive number, a flag with no value). */
export function parseArgs(argv) {
  const arm = argv[0];
  if (arm !== 'chat' && arm !== 'hx3') return null;
  const flag = (name, dflt, ok) => {
    const i = argv.indexOf(name);
    if (i < 0) return dflt;
    const s = argv[i + 1];
    const v = s === undefined || s.trim() === '' ? NaN : Number(s);
    return ok(v) ? v : null;
  };
  const runs = flag('--runs', 1, (v) => Number.isInteger(v) && v > 0);
  const maxHours = flag('--max-hours', 4, (v) => v > 0);
  const maxUsd = flag('--max-usd', 60, (v) => v > 0);
  if (runs === null || maxHours === null || maxUsd === null) return null;
  // --config key=value (repeatable): overrides of the arm's .hx/config.json; the value is JSON when it parses, else a string
  const config = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--config') continue;
    const m = /^([A-Za-z_][\w]*)=(.*)$/.exec(argv[i + 1] ?? '');
    if (!m) return null;
    let v = m[2];
    try { v = JSON.parse(v); } catch { /* a plain string */ }
    config[m[1]] = v;
  }
  return Object.keys(config).length ? { arm, runs, maxHours, maxUsd, config } : { arm, runs, maxHours, maxUsd };
}

/** What the `chat` arm's one session is given: the default model and effort, and Hx's lean flags as `extraArgs`
 *  (`workerArgs` of the default config: the lean set with `--tools` of the default workerTools, then claudeArgs). */
export function chatSession(defaults = DEFAULTS) {
  return { model: defaults.model, effort: defaults.effort, extraArgs: workerArgs(defaults) };
}

/** The `roles` of a run's provenance. `chat`: one role, `chat`, from the chat session's values. `hx3`: every role in
 *  ROLES, ran or not, from the arm's config as `hx run` loads it: model and effort from roleModel, flags from
 *  workerArgs (every session `hx run` starts gets them). The flags leave out what every claude session gets (`-p`,
 *  `--output-format`, `--model`, …): workerArgs holds none of those. */
export function provenanceRoles(arm, { config, chat = chatSession() } = {}) {
  if (arm === 'chat') return { chat: { model: chat.model, effort: chat.effort, flags: [...chat.extraArgs] } };
  const flags = workerArgs(config);
  return Object.fromEntries(ROLES.map((r) => [r, { ...roleModel(config, r), flags: [...flags] }]));
}
