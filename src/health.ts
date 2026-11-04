// The health pass: pure checks over one snapshot of the board, the worktrees and the machine, then a runner that
// applies their repairs (hx health --fix) or reports what it would do (hx health). The checks run in a fixed order;
// an issue one check acts on or reports is `seen` and skipped by the checks after it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, Project } from './config.ts';
import { doctor, type Check } from './doctor.ts';
import { run } from './exec.ts';
import { readGateRuns, remoteSha, type GateRun } from './gate.ts';
import * as gh from './github.ts';
import { pidAlive, readLive } from './runstate.ts';
import { trustedSet } from './state.ts';
import { removeWorktree } from './worktree.ts';

/** .hx/health.json: when a pass first saw each stuck claim (number → ISO time) and the last pass's summary line. */
export interface HealthFile { stuck?: Record<string, string>; last?: { at: string; line: string } }

export interface HealthWorktree { name: string; mtimeMs: number }

/** What the environment check reads: the doctor checks and the free bytes on the worktree root's drive (null = unknown). */
export interface HealthEnv { checks: Check[]; freeBytes: number | null }

export interface HealthSnapshot {
  issues: gh.Issue[]; // open and closed, as gh.listIssues returns them
  openPrs: gh.IssuePr[]; // open PRs from issue/<N> branches
  mergedPrs: gh.IssuePr[]; // merged PRs from issue/<N> branches
  comments: Map<number, string[]>; // trusted comment bodies, only for the issues a check needs (agent-blocked)
  live: Set<number>; // issue / PRD numbers in a session of a live runner
  worktrees: HealthWorktree[]; // directories directly under config.worktreeRoot
  gateRuns: GateRun[];
  health: HealthFile;
  headSha: string; // origin/<default>
  now: number; // ms epoch of this pass
  config: Pick<Config, 'stallMinutes' | 'labels'>;
  env: HealthEnv | null; // null: the environment check is skipped
}

export type HealthMark = '✓' | '✗' | 'fixed' | 'filed';

/** One printed line. A finding (✗) that an action can repair has `fix`: the past-tense summary once repaired. */
export interface HealthResult { mark: HealthMark; text: string; fix?: string }

export type HealthAction =
  | { kind: 'close-pr'; pr: number; issue: number; comment: string; result: HealthResult; would: string }
  | { kind: 'remove-label'; issue: number; label: string; result: HealthResult; would: string }
  | { kind: 'remove-worktree'; name: string; result: HealthResult; would: string }
  | { kind: 'first-seen'; issue: number; at: string } // bookkeeping: applied with repairs on or off
  | { kind: 'forget-seen'; issue: number };

export type Repair = Extract<HealthAction, { would: string }>;

export interface CheckOutput { results: HealthResult[]; actions: HealthAction[] }
export type HealthCheck = (s: HealthSnapshot, seen: Set<number>) => CheckOutput;

export const DISK_MIN_BYTES = 5 * 1024 ** 3;
const DAY_MS = 86_400_000;

const issueOf = (branch: string): number | null => { const m = /^issue\/(\d+)$/.exec(branch); return m ? Number(m[1]) : null; };

/** An open PR from issue/<N> whose issue is closed, or whose issue already has another merged PR: closed, branch kept. */
export const stalePrCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const byNumber = new Map(s.issues.map((i) => [i.number, i]));
  for (const pr of s.openPrs) {
    const n = issueOf(pr.headRefName);
    if (n === null || s.live.has(n) || seen.has(n)) continue;
    const issue = byNumber.get(n);
    if (!issue) continue;
    const merged = s.mergedPrs.find((m) => m.headRefName === pr.headRefName && m.number !== pr.number);
    const why = issue.state === 'CLOSED' ? `issue #${n} is closed` : merged ? `issue #${n} already has merged PR #${merged.number}` : null;
    if (!why) continue;
    seen.add(n);
    const result: HealthResult = { mark: '✗', text: `stale PR #${pr.number} — ${why}`, fix: `closed stale PR #${pr.number}` };
    results.push(result);
    actions.push({ kind: 'close-pr', pr: pr.number, issue: n, comment: `**hx:** closing — ${why}`, result, would: `would close PR #${pr.number}` });
  }
  if (!results.length) results.push({ mark: '✓', text: 'stale PRs — none' });
  return { results, actions };
};

/** An open issue or PRD labelled agent-working in no live session: released once a pass saw it so for stallMinutes. */
export const stuckLabelCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const L = s.config.labels;
  const known = s.health.stuck ?? {};
  const stuck = new Set<number>();
  for (const i of s.issues) {
    if (i.state !== 'OPEN' || !i.labels.includes(L.working) || s.live.has(i.number) || seen.has(i.number)) continue;
    stuck.add(i.number);
    seen.add(i.number);
    const first = known[String(i.number)];
    if (!first || Number.isNaN(Date.parse(first))) {
      actions.push({ kind: 'first-seen', issue: i.number, at: new Date(s.now).toISOString() });
      results.push({ mark: '✗', text: `#${i.number} ${L.working} with no live session — first seen now, released after ${s.config.stallMinutes} min` });
      continue;
    }
    const ageMin = (s.now - Date.parse(first)) / 60_000;
    if (ageMin > s.config.stallMinutes) {
      const result: HealthResult = { mark: '✗', text: `#${i.number} ${L.working} with no live session for ${Math.floor(ageMin)} min`, fix: `released #${i.number}` };
      results.push(result);
      actions.push({ kind: 'remove-label', issue: i.number, label: L.working, result, would: `would remove ${L.working}` });
    } else {
      results.push({ mark: '✗', text: `#${i.number} ${L.working} with no live session for ${Math.floor(ageMin)} min — released after ${s.config.stallMinutes} min` });
    }
  }
  for (const k of Object.keys(known)) if (!stuck.has(Number(k)) && !seen.has(Number(k))) actions.push({ kind: 'forget-seen', issue: Number(k) });
  if (!results.length) results.push({ mark: '✓', text: 'stuck labels — none' });
  return { results, actions };
};

/** i<N> a<N> t<N> (issue N) and p<N> (PRD N) under the worktree root, N not open, untouched for 24 h: removed. */
export const leftoverWorktreeCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const open = new Set(s.issues.filter((i) => i.state === 'OPEN').map((i) => i.number));
  for (const w of s.worktrees) {
    const m = /^[iatp](\d+)$/.exec(w.name);
    if (!m) continue;
    const n = Number(m[1]);
    if (open.has(n) || s.live.has(n) || seen.has(n) || s.now - w.mtimeMs <= DAY_MS) continue;
    seen.add(n);
    const result: HealthResult = { mark: '✗', text: `leftover worktree ${w.name} — #${n} is not open, untouched for ${Math.floor((s.now - w.mtimeMs) / 3_600_000)} h`, fix: `removed worktree ${w.name}` };
    results.push(result);
    actions.push({ kind: 'remove-worktree', name: w.name, result, would: `would remove ${w.name} (its branch is kept)` });
  }
  if (!results.length) results.push({ mark: '✓', text: 'leftover worktrees — none' });
  return { results, actions };
};

/** The hx doctor checks and the free disk on the worktree root's drive: reported, never repaired, never filed. */
export const environmentCheck: HealthCheck = (s) => {
  const results: HealthResult[] = [];
  if (!s.env) return { results, actions: [] };
  for (const c of s.env.checks)
    if (c.mark === '✗') results.push({ mark: '✗', text: `environment: ${c.label}${c.detail ? ` — ${c.detail}` : ''}${c.fix ? ` (fix: ${c.fix})` : ''}` });
  const free = s.env.freeBytes;
  if (free !== null && free < DISK_MIN_BYTES) results.push({ mark: '✗', text: `environment: ${(free / 1024 ** 3).toFixed(1)} GB free on the worktree drive (below 5 GB)` });
  if (!results.length) results.push({ mark: '✓', text: `environment — ok${free !== null ? ` (${(free / 1024 ** 3).toFixed(0)} GB free)` : ''}` });
  return { results, actions: [] };
};

/** The checks in pass order. A null slot is a check a later issue adds: it only puts its function there. */
export const CHECKS: { name: string; check: HealthCheck | null }[] = [
  { name: 'stale-pr', check: stalePrCheck },
  { name: 'blocked-after-pass', check: null },
  { name: 'gate-fix', check: null },
  { name: 'transient-block', check: null },
  { name: 'leftover-worktree', check: leftoverWorktreeCheck },
  { name: 'stuck-label', check: stuckLabelCheck },
  { name: 'environment', check: environmentCheck },
];

/** Every check in order over one snapshot, sharing one `seen` set. */
export function runChecks(s: HealthSnapshot, checks = CHECKS): CheckOutput {
  const seen = new Set<number>();
  const out: CheckOutput = { results: [], actions: [] };
  for (const { check } of checks) {
    if (!check) continue;
    const r = check(s, seen);
    out.results.push(...r.results);
    out.actions.push(...r.actions);
  }
  return out;
}

/** `health: 3 ✓ · 1 ✗ · fixed 2 (closed stale PR #91, removed worktree i71) · filed 1 (#200)`. */
export function healthLine(results: HealthResult[]): string {
  const of = (m: HealthMark) => results.filter((r) => r.mark === m);
  const parts = [`${of('✓').length} ✓`];
  const bad = of('✗').length;
  if (bad) parts.push(`${bad} ✗`);
  for (const m of ['fixed', 'filed'] as const) {
    const rs = of(m);
    if (rs.length) parts.push(`${m} ${rs.length} (${rs.map((r) => r.fix ?? r.text).join(', ')})`);
  }
  return `health: ${parts.join(' · ')}`;
}

export const renderResult = (r: HealthResult) => `${r.mark} ${r.text}`;

// ---- I/O: the snapshot, applying the actions, health.json ----

const healthFile = (stateDir: string) => path.join(stateDir, 'health.json');

export function readHealth(stateDir: string): HealthFile {
  try { return JSON.parse(readFileSync(healthFile(stateDir), 'utf8')); } catch { return {}; }
}

export function writeHealth(stateDir: string, h: HealthFile): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(healthFile(stateDir), JSON.stringify(h, null, 2) + '\n');
}

function listWorktrees(root: string): HealthWorktree[] {
  if (!existsSync(root)) return [];
  const out: HealthWorktree[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try { out.push({ name: e.name, mtimeMs: statSync(path.join(root, e.name)).mtimeMs }); } catch {}
  }
  return out;
}

/** Free bytes on the drive holding `dir` (its nearest existing ancestor), or null when it cannot tell. */
export function freeBytes(dir: string): number | null {
  let d = path.resolve(dir);
  while (!existsSync(d)) { const up = path.dirname(d); if (up === d) return null; d = up; }
  try { const s = statfsSync(d); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

export interface HealthOptions {
  repairs: boolean; // apply the repairs; off: report each finding as ✗ with what would be done
  now?: number;
  live?: Set<number>; // the numbers in a live session (default: live.json's sessions when its pid is alive)
  env?: () => Promise<HealthEnv | null>; // default: doctor() and the free disk of the worktree root
}

export interface HealthPass { results: HealthResult[]; line: string; code: number }

async function snapshot(p: Project, o: HealthOptions, now: number): Promise<HealthSnapshot> {
  const c = p.config;
  const [issues, openPrs, mergedPrs, headSha] = await Promise.all([
    gh.listIssues(c.repo), gh.listIssuePrs(c.repo, 'open'), gh.listIssuePrs(c.repo, 'merged'), remoteSha(p.root, c.defaultBranch)]);
  const comments = new Map<number, string[]>();
  const blocked = issues.filter((i) => i.state === 'OPEN' && i.labels.includes(c.labels.blocked));
  if (blocked.length) {
    const trusted = trustedSet(await gh.ghLogin(), c.trustedAuthors ?? []);
    for (const i of blocked) comments.set(i.number, await gh.commentBodies(c.repo, i.number, trusted));
  }
  let live = o.live;
  if (!live) {
    const l = readLive(p.stateDir);
    live = new Set(l && typeof l.pid === 'number' && pidAlive(l.pid) ? (l.sessions ?? []).map((x) => x.number) : []);
  }
  const env = o.env ? await o.env() : { checks: (await doctor({ cwd: p.root })).checks, freeBytes: freeBytes(c.worktreeRoot) };
  return { issues, openPrs, mergedPrs, comments, live, worktrees: listWorktrees(c.worktreeRoot), gateRuns: readGateRuns(p.stateDir),
    health: readHealth(p.stateDir), headSha, now, config: { stallMinutes: c.stallMinutes, labels: c.labels }, env };
}

async function repair(p: Project, a: Repair): Promise<void> {
  const c = p.config;
  if (a.kind === 'close-pr') await gh.closePr(c.repo, a.pr, a.comment);
  else if (a.kind === 'remove-label') await gh.editLabels(c.repo, a.issue, [], [a.label]);
  else {
    const dir = path.join(c.worktreeRoot, a.name);
    await removeWorktree(p.root, dir); // never throws; the local branch is kept
    if (existsSync(dir)) throw new Error(`${dir} is still there (in use?)`);
  }
}

/** One health pass: snapshot, checks, the actions applied (repairs only when o.repairs), health.json written. */
export async function healthPass(p: Project, o: HealthOptions): Promise<HealthPass> {
  const now = o.now ?? Date.now();
  const s = await snapshot(p, o, now);
  const { results, actions } = runChecks(s);
  const h: HealthFile = { ...s.health, stuck: { ...(s.health.stuck ?? {}) } };
  if (o.repairs) await run(process.env.HX_GIT_BIN || 'git', ['-C', p.root, 'worktree', 'prune']);
  for (const a of actions) {
    if (a.kind === 'first-seen') { h.stuck![String(a.issue)] = a.at; continue; }
    if (a.kind === 'forget-seen') { delete h.stuck![String(a.issue)]; continue; }
    if (!o.repairs) { a.result.text += ` — ${a.would}`; continue; }
    try {
      await repair(p, a);
      a.result.mark = 'fixed';
      a.result.text = `${a.result.fix} (${a.result.text})`;
      if (a.kind === 'remove-label') delete h.stuck![String(a.issue)];
    } catch (e: any) {
      a.result.text += ` — repair failed: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }
  const line = healthLine(results);
  h.last = { at: new Date(now).toISOString(), line };
  writeHealth(p.stateDir, h);
  return { results, line, code: results.some((r) => r.mark === '✗') ? 1 : 0 };
}
