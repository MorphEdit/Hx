// CI gate: the default branch is tested after every merge (and at start). While it is red, hx claims
// nothing except the issue that fixes it — which hx files itself — so no worker builds on a broken base.
// Hx repos usually have no hosted CI, so the gate is local: the project's test command on a fresh
// checkout of origin/<base>.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run, runShell } from './exec.ts';
import { median } from './timing.ts';
import { setupWorktree, type SetupOptions, type SetupResult } from './setup.ts';
import { addWorktree, removeWorktree } from './worktree.ts';

export interface GateResult {
  sha: string;
  ok: boolean;
  command: string;
  output: string; // tail of the test output
  timedOut?: boolean; // the command ran past the timeout: its process tree was killed
  aborted?: boolean; // the signal fired (Ctrl+C): the tree was killed and the result means nothing
  killed?: Promise<void>; // with aborted: settles once the killed tree is gone (never written to gate.json)
  setupFailed?: boolean; // the worktree setup failed (`command` is then config.worktreeSetup): the test command never ran
  durationMs?: number; // wall-clock time of the test command only (not the worktree add, setup or cleanup); absent when it never finished
  at: string;
}

/** The gate's worktree setup step; `onSetup` sees every setup that ran to an end (not aborted). */
export interface GateSetup {
  stateDir: string;
  config: SetupOptions['config'];
  log: (msg: string) => void;
  onSetup?: (r: SetupResult) => void;
}

export interface GateState {
  command?: string; // learned from the implementer's ship call when config.gateCommand is empty
  last?: GateResult;
  fixIssue?: number; // the open issue hx filed for the current red
}

const file = (stateDir: string) => path.join(stateDir, 'gate.json');

export function readGate(stateDir: string): GateState {
  try { return JSON.parse(readFileSync(file(stateDir), 'utf8')); } catch { return {}; }
}

export function writeGate(stateDir: string, s: GateState): void {
  writeFileSync(file(stateDir), JSON.stringify(s, null, 2));
}

/** One pool gate run whose test command ran to an end or timed out: a line of .hx/gate-runs.jsonl. */
export interface GateRun { ts: string; sha: string; ok: boolean; durationMs: number; timedOut: boolean }

const runsFile = (stateDir: string) => path.join(stateDir, 'gate-runs.jsonl');

export function appendGateRun(stateDir: string, r: GateResult): void {
  const line: GateRun = { ts: r.at, sha: r.sha, ok: r.ok, durationMs: r.durationMs ?? 0, timedOut: !!r.timedOut };
  appendFileSync(runsFile(stateDir), JSON.stringify(line) + '\n');
}

/** The lines of .hx/gate-runs.jsonl, oldest first; malformed lines are skipped. */
export function readGateRuns(stateDir: string): GateRun[] {
  let text = '';
  try { text = readFileSync(runsFile(stateDir), 'utf8'); } catch { return []; }
  const out: GateRun[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && typeof r.ok === 'boolean') out.push(r);
    } catch {}
  }
  return out;
}

/** `15m10s`, `20m`, `45s`. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m${String(r).padStart(2, '0')}s` : `${m}m`;
}

/** The slow-gate warning when the median duration of the last 5 runs is above 70% of gateMinutes, else undefined. */
export function slowGateWarning(runs: GateRun[], gateMinutes: number): string | undefined {
  if (runs.length < 5) return undefined;
  const m = median(runs.slice(-5).map((r) => r.durationMs))!;
  const limit = gateMinutes * 60_000;
  if (m <= 0.7 * limit) return undefined;
  return `gate is slow: median ${fmtDuration(m)} of a ${fmtDuration(limit)} timeout — tests may time out under load`;
}

/** The commit origin/<base> points at right now. */
export async function remoteSha(checkout: string, base: string): Promise<string> {
  const r = await run(process.env.HX_GIT_BIN || 'git', ['-C', checkout, 'ls-remote', 'origin', `refs/heads/${base}`]);
  return r.stdout.split(/\s/)[0] ?? '';
}

const tailOf = (s: string, n: number) => s.trim().split('\n').slice(-n).join('\n');

/**
 * Run `command` on a fresh checkout of origin/<base>; `signal` aborts it (the result then has `aborted`).
 * With `setup`, the worktree setup runs first; when it fails the command does not run and the result has
 * `setupFailed`. The gate never writes a setup record. An aborted result can return before the killed tree is
 * gone: await its `killed` before exiting. With `at`, the checkout first moves to that commit of origin/<base>'s
 * history (a watched self-update re-runs a red gate at the old sha, #316). `env` is added to the command's env
 * (HX_TEST_CONCURRENCY, #350).
 */
export async function runGate(checkout: string, root: string, base: string, command: string, timeoutMs = 45 * 60_000,
  signal?: AbortSignal, setup?: GateSetup, at?: string, env?: Record<string, string>): Promise<GateResult> {
  const wt = await addWorktree(checkout, root, { name: 'gate', branch: 'hx/gate', base, fresh: true });
  let aborted = false;
  try {
    if (at) {
      const co = await run(process.env.HX_GIT_BIN || 'git', ['-C', wt.dir, 'checkout', '-q', '--detach', at]);
      if (co.code !== 0) throw new Error(`git checkout ${at.slice(0, 7)}: ${(co.stderr || co.stdout).trim().split(/\r?\n/)[0]}`);
    }
    const sha = (await run(process.env.HX_GIT_BIN || 'git', ['-C', wt.dir, 'rev-parse', 'HEAD'])).stdout.trim();
    const s = setup && await setupWorktree({ checkout, dir: wt.dir, name: 'gate', stateDir: setup.stateDir, config: setup.config, signal, log: setup.log });
    if (s?.aborted) { aborted = true; return { sha, ok: false, command: s.command, output: s.tail, aborted: true, at: new Date().toISOString() }; }
    if (s) setup!.onSetup?.(s);
    if (s && !s.ok) {
      let full = s.tail;
      try { full = readFileSync(path.join(setup!.stateDir, 'logs', 'setup-gate.log'), 'utf8'); } catch {}
      const note = s.timedOut ? `\nsetup: timed out after ${setup!.config.worktreeSetupMinutes} min — process tree killed` : '';
      return { sha, ok: false, command: s.command, output: `worktree setup failed: ${tailOf(full + note, 60)}`, setupFailed: true,
        ...(s.timedOut ? { timedOut: true } : {}), at: new Date().toISOString() };
    }
    const started = Date.now();
    const res = await runShell(command, { cwd: wt.dir, timeoutMs, signal, killLater: true, env });
    const durationMs = Date.now() - started;
    aborted = !!res.aborted;
    if (res.aborted) return { sha, ok: false, command, output: res.output.trim().split('\n').slice(-60).join('\n'), aborted: true, killed: res.killed, at: new Date().toISOString() };
    const note = res.timedOut ? `\ngate: timed out after ${+(timeoutMs / 60_000).toFixed(2)} min — process tree killed` : '';
    return { sha, ok: res.code === 0 && !res.timedOut, command, output: (res.output.trim() + note).trim().split('\n').slice(-60).join('\n'),
      ...(res.timedOut ? { timedOut: true } : {}), durationMs, at: new Date().toISOString() };
  } finally {
    // after Ctrl+C Windows may hold the killed tree's files for seconds: do not wait (the next gate's fresh add clears it)
    const removed = removeWorktree(checkout, wt.dir);
    if (aborted) removed.catch(() => {}); else await removed;
  }
}

export const gateIssueTitle = (base: string, r: GateResult) => r.setupFailed
  ? `Default branch is red: the worktree setup \`${r.command}\` (worktreeSetup) fails on ${base} at ${r.sha.slice(0, 7)}`
  : `Default branch is red: \`${r.command}\` fails on ${base} at ${r.sha.slice(0, 7)}`;

export const gateIssueBody = (base: string, r: GateResult) => r.setupFailed ? setupBody(base, r) : testBody(base, r);

const setupBody = (base: string, r: GateResult) => `hx tests \`${base}\` after every merge, in a fresh worktree prepared by the worktree setup
command \`${r.command}\` (the \`worktreeSetup\` config). At ${r.sha} that setup command fails, 3 tries in a row, so the
test command never ran and hx claims no other work until \`${base}\` is green again.

Make \`${r.command}\` succeed on a fresh checkout of \`${base}\` again: the worktree setup fails, not the test command.
Find the cause (\`git log\` shows what merged last, e.g. a dependency or lockfile change) and fix it. If the
\`worktreeSetup\` config itself is wrong, say so in your handoff. Do not skip, delete or weaken tests to get green.

Output (tail):

\`\`\`
${r.output.slice(-6000)}
\`\`\`

## Blocked by
None
`;

const testBody = (base: string, r: GateResult) => `hx tests \`${base}\` after every merge. At ${r.sha} \`${r.command}\` fails, so hx claims no other work until \`${base}\` is green again.

Make \`${r.command}\` pass on \`${base}\` again: find the cause (\`git log\` shows what merged last), fix it, and
add a test if one was missing. Do not skip, delete or weaken tests to get green.

Output (tail):

\`\`\`
${r.output.slice(-6000)}
\`\`\`

## Blocked by
None
`;
