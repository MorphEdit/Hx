// The health pass: pure checks over one snapshot of the board, the worktrees and the machine, then a runner that
// applies their repairs (hx health --fix) or reports what it would do (hx health). The checks run in a fixed order;
// an issue one check acts on or reports is `seen` and skipped by the checks after it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, Project } from './config.ts';
import { doctor, type Check } from './doctor.ts';
import { run } from './exec.ts';
import { readGate, readGateRuns, remoteSha, writeGate, type GateRun } from './gate.ts';
import * as gh from './github.ts';
import { AUDIT_MARKER, mergeAudited, shipInfo } from './pool.ts';
import { outsideTestEnv } from './concurrency.ts';
import { testedTreesEnv } from './tested.ts';
import { pidAlive, readLive } from './runstate.ts';
import { trustedSet } from './state.ts';
import { addWorktree, implWorktree, removeWorktree } from './worktree.ts';

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
  | { kind: 'resume'; issue: number; pr: number; result: HealthResult; would: string } // ship.mjs --resume; failed: sent back
  | { kind: 'send-back'; issue: number; why: string; result: HealthResult; would: string } // to ready-for-agent, with a resume comment
  | { kind: 'unblock'; issue: number; comment: string; result: HealthResult; would: string }
  | { kind: 'file'; key: string; title: string; body: string; result: HealthResult; would: string } // a `health:` bug issue
  | { kind: 'close-issue'; issue: number; comment: string; result: HealthResult; would: string } // closed as not planned
  | { kind: 'request-gate'; issue?: number; result: HealthResult } // one more gate run: only a runner with a gate applies it
  | { kind: 'first-seen'; issue: number; at: string } // bookkeeping: applied with repairs on or off
  | { kind: 'forget-seen'; issue: number };

export type Repair = Extract<HealthAction, { would: string }>;

export interface CheckOutput { results: HealthResult[]; actions: HealthAction[] }
export type HealthCheck = (s: HealthSnapshot, seen: Set<number>) => CheckOutput;

export const DISK_MIN_BYTES = 5 * 1024 ** 3;
const DAY_MS = 86_400_000;

/** Every comment the blocked-after-PASS check writes carries it: an issue that has one is not repaired again. */
export const RESUME_MARKER = '<!-- hx:health resume -->';
/** The start of a transient unblock comment: `<!-- hx:health unblock <ISO time> -->`. */
export const unblockMarker = (at: number) => `<!-- hx:health unblock ${new Date(at).toISOString()} -->`;
/** The marker in a filed `health:` issue's body: `<!-- hx:health <check>:<subject> -->`. */
export const healthKeyMarker = (key: string) => `<!-- hx:health ${key} -->`;

/** Stop reasons whose cause is gone by the time a pass runs (it runs only outside usage holds and a low GitHub budget). */
export const TRANSIENT_PATTERNS: RegExp[] = [/stalled: no output/i, /turn timed out after/i, /claude exited -?\d+ with no result/i,
  /API 429/i, /API 5\d\d/i, /rate limit/i];

/** The reason of a pool fail() stop comment (`**hx:** <kind> stopped — <reason>`, up to `Last reply:`), or null. */
export function stopReason(body: string): string | null {
  const m = /^\*\*hx:\*\* \S+ stopped — ([\s\S]*)$/.exec(body.trimStart());
  return m ? m[1].split('Last reply:')[0].trim() : null;
}

/** A stop reason the transient-block check may undo: it matches a pattern and is not a failed merge. */
export const isTransient = (reason: string): boolean =>
  !/^merging the audited PR failed/i.test(reason) && TRANSIENT_PATTERNS.some((p) => p.test(reason));

/** Whether the last hx audit comment says PASS ✓. */
const lastAuditPassed = (comments: string[]): boolean => {
  const audit = comments.filter((b) => b.trimStart().startsWith(AUDIT_MARKER)).at(-1);
  return !!audit && audit.includes('PASS ✓');
};

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

/** The open agent-blocked issues no live session holds and no earlier check took, with their trusted comments. */
const blockedIssues = (s: HealthSnapshot, seen: Set<number>) =>
  s.issues.filter((i) => i.state === 'OPEN' && i.labels.includes(s.config.labels.blocked) && !s.live.has(i.number) && !seen.has(i.number))
    .map((i) => ({ n: i.number, comments: s.comments.get(i.number) ?? [], pr: s.openPrs.find((p) => issueOf(p.headRefName) === i.number) }));

/**
 * An agent-blocked issue with an open PR from issue/<N> whose last hx audit passed: MERGEABLE → the ship resume path,
 * CONFLICTING → back to ready-for-agent, anything else (UNKNOWN) → wait. Once per issue: blocked again after a
 * resume comment, it files a `health:` issue instead (unless one with its marker exists, open or closed).
 */
export const blockedAfterPassCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const L = s.config.labels;
  for (const { n, comments, pr } of blockedIssues(s, seen)) {
    if (!pr || !lastAuditPassed(comments)) continue;
    seen.add(n);
    if (comments.some((b) => b.includes(RESUME_MARKER))) {
      const key = `resume:${n}`;
      const filed = s.issues.find((x) => x.body.includes(healthKeyMarker(key)));
      if (filed) { results.push({ mark: '✗', text: `#${n} ${L.blocked} again after its resume — health issue #${filed.number} is filed` }); continue; }
      const result: HealthResult = { mark: '✗', text: `#${n} ${L.blocked} again after its audited PR #${pr.number} was resumed once` };
      results.push(result);
      actions.push({ kind: 'file', key, result, would: 'would file a health: issue',
        title: `health: #${n} blocked again after its audited PR #${pr.number} was resumed`,
        body: `${healthKeyMarker(key)}\nIssue #${n} passed its audit (PR #${pr.number} is open), was resumed once by the health pass, and is labelled \`${L.blocked}\` again. `
          + `The health pass does not repair it a second time. Read the comments on #${n}, find why the merge keeps failing, and fix that.` });
    } else if (pr.mergeable === 'MERGEABLE') {
      const result: HealthResult = { mark: '✗', text: `#${n} ${L.blocked} after a passed audit — PR #${pr.number} is mergeable` };
      results.push(result);
      actions.push({ kind: 'resume', issue: n, pr: pr.number, result, would: `would merge PR #${pr.number} (ship --resume)` });
    } else if (pr.mergeable === 'CONFLICTING') {
      const result: HealthResult = { mark: '✗', text: `#${n} ${L.blocked} after a passed audit — PR #${pr.number} conflicts with the base`, fix: `sent #${n} back to ${L.ready}` };
      results.push(result);
      actions.push({ kind: 'send-back', issue: n, why: `PR #${pr.number} conflicts with the base branch`, result, would: `would send it back to ${L.ready}` });
    } else {
      results.push({ mark: '✗', text: `#${n} ${L.blocked} after a passed audit — PR #${pr.number} mergeable is ${pr.mergeable ?? 'unknown'}, waiting` });
    }
  }
  if (!results.length) results.push({ mark: '✓', text: 'blocked after a passed audit — none' });
  return { results, actions };
};

/**
 * An agent-blocked issue whose last hx comment is a pool stop with a transient reason: unblocked, at most once
 * per issue per 24 h. Every other block is not a finding: neither reported nor filed.
 */
export const transientBlockCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const L = s.config.labels;
  for (const { n, comments, pr } of blockedIssues(s, seen)) {
    if (pr && lastAuditPassed(comments)) continue; // the blocked-after-PASS check's, whatever its stop comment says
    const reason = stopReason(comments.at(-1) ?? '');
    if (reason === null || !isTransient(reason)) continue;
    seen.add(n);
    const last = Math.max(-Infinity, ...comments.map((b) => /^<!-- hx:health unblock (\S+) -->/.exec(b.trimStart())?.[1] ?? '')
      .map(Date.parse).filter((t) => !Number.isNaN(t)));
    if (s.now - last < DAY_MS) {
      results.push({ mark: '✗', text: `#${n} ${L.blocked} by a transient error again — unblocked ${Math.floor((s.now - last) / 3_600_000)} h ago, once per 24 h` });
      continue;
    }
    const result: HealthResult = { mark: '✗', text: `#${n} ${L.blocked} by a transient error — ${reason.split('\n')[0].slice(0, 160)}`, fix: `unblocked #${n}` };
    results.push(result);
    actions.push({ kind: 'unblock', issue: n, result, would: `would remove ${L.blocked}`,
      comment: `${unblockMarker(s.now)}\n**hx:** unblocked — the stop was transient: ${reason}` });
  }
  if (!results.length) results.push({ mark: '✓', text: 'blocked by a transient error — none' });
  return { results, actions };
};

export const WAITING_GATE = 'waiting for a second green gate run';

/** An open gate-fix issue: closed when the last two real gate runs (reused lines left out, #352) are green at origin's
 *  head; one more gate run asked for while only the last is green there; left alone while the last is red or there is
 *  none (the issue is real). */
export const gateFixCheck: HealthCheck = (s, seen) => {
  const results: HealthResult[] = [], actions: HealthAction[] = [];
  const runs = s.gateRuns.filter((r) => !r.reused);
  const last = runs.at(-1), prev = runs.length > 1 ? runs.at(-2) : undefined;
  const greenAtHead = (r?: GateRun) => !!r && r.ok && !!s.headSha && r.sha === s.headSha;
  for (const i of s.issues) {
    if (i.state !== 'OPEN' || !i.labels.includes(s.config.labels.gateFix) || s.live.has(i.number) || seen.has(i.number)) continue;
    if (!last || !last.ok) {
      results.push({ mark: '✓', text: `gate-fix #${i.number} — main is ${last ? 'red' : 'untested'}, the issue stands` });
      continue;
    }
    seen.add(i.number);
    if (greenAtHead(last) && greenAtHead(prev)) {
      const why = `the last two gate runs are green at ${s.headSha.slice(0, 7)}`;
      const result: HealthResult = { mark: '✗', text: `gate-fix #${i.number} open — ${why}`, fix: `closed gate-fix #${i.number}` };
      results.push(result);
      actions.push({ kind: 'close-issue', issue: i.number, comment: `**hx:** closing as not planned — ${why}: main is green again`, result,
        would: `would close #${i.number} as not planned` });
    } else {
      const result: HealthResult = { mark: '✗', text: `gate-fix #${i.number} — ${WAITING_GATE}` };
      results.push(result);
      actions.push({ kind: 'request-gate', issue: i.number, result });
    }
  }
  if (!results.length) results.push({ mark: '✓', text: 'gate-fix issues — none' });
  return { results, actions };
};

/** The newest gate run a reused green at origin's head (#352): one full run asked for, so a flaky test cannot hide
 *  behind reused results. */
export const reusedGateCheck: HealthCheck = (s) => {
  const last = s.gateRuns.at(-1);
  if (!last?.reused || !last.ok || !s.headSha || last.sha !== s.headSha)
    return { results: [{ mark: '✓', text: 'reused gate run at head — none' }], actions: [] };
  const result: HealthResult = { mark: '✗', text: `gate green at ${s.headSha.slice(0, 7)} reused a tested tree — waiting for a full gate run` };
  return { results: [result], actions: [{ kind: 'request-gate', result }] };
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
  { name: 'blocked-after-pass', check: blockedAfterPassCheck },
  { name: 'gate-fix', check: gateFixCheck },
  { name: 'gate-reuse', check: reusedGateCheck },
  { name: 'transient-block', check: transientBlockCheck },
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
  merged?: (test?: string) => void; // hx run: a merge this pass made (its post-merge gate check runs); hx health passes none
  // hx run's gate, asked for one more run (true = one was started). Absent (hx health), or with repairs off: never asked.
  requestGate?: () => boolean;
  // a gate-fix issue was closed (default: cleared from gate.json's fixIssue; hx run clears its own copy)
  closedGateFix?: (issue: number) => void;
  // the HX_TEST_CONCURRENCY env of a resume repair's ship --resume, taken as it starts (default: the n = 1 value, hx health --fix)
  testEnv?: () => Record<string, string>;
}

/** changed: a repair was applied or a gate run requested, so hx run re-reads the board at once. */
export interface HealthPass { results: HealthResult[]; line: string; code: number; changed: boolean }

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
  const env = o.env ? await o.env() : { checks: (await doctor({ cwd: p.root, skipRtdd: true, skipAutoStart: true })).checks, freeBytes: freeBytes(c.worktreeRoot) };
  return { issues, openPrs, mergedPrs, comments, live, worktrees: listWorktrees(c.worktreeRoot), gateRuns: readGateRuns(p.stateDir),
    health: readHealth(p.stateDir), headSha, now, config: { stallMinutes: c.stallMinutes, labels: c.labels }, env };
}

/** Back to ready-for-agent with a resume comment: the next impl session resumes issue/<N>. */
async function sendBack(p: Project, n: number, why: string, output?: string): Promise<void> {
  const L = p.config.labels;
  await gh.editLabels(p.config.repo, n, [L.ready], [L.blocked]);
  const tail = output ? `\n\nShip output (tail):\n\n\`\`\`\n${output.trim().split('\n').slice(-30).join('\n').slice(-3000)}\n\`\`\`` : '';
  await gh.comment(p.config.repo, n, `${RESUME_MARKER}\n**hx:** the audit passed, but ${why}. Back to \`${L.ready}\`: `
    + `the next session resumes branch \`issue/${n}\`.${tail}`);
}

/** Applies one repair; returns how its line reads once done (`fix`, and `filed` for a filed issue). */
async function repair(p: Project, a: Repair, o: HealthOptions): Promise<{ fix: string; mark?: HealthMark } | void> {
  const c = p.config;
  if (a.kind === 'close-pr') await gh.closePr(c.repo, a.pr, a.comment);
  else if (a.kind === 'close-issue') {
    await gh.closeIssue(c.repo, a.issue, a.comment, 'not planned');
    if (o.closedGateFix) o.closedGateFix(a.issue);
    else { const gs = readGate(p.stateDir); if (gs.fixIssue === a.issue) { gs.fixIssue = undefined; writeGate(p.stateDir, gs); } }
  }
  else if (a.kind === 'remove-label') await gh.editLabels(c.repo, a.issue, [], [a.label]);
  else if (a.kind === 'unblock') {
    await gh.editLabels(c.repo, a.issue, [], [c.labels.blocked]);
    await gh.comment(c.repo, a.issue, a.comment);
  } else if (a.kind === 'send-back') await sendBack(p, a.issue, a.why);
  else if (a.kind === 'file') {
    const url = await gh.createIssue(c.repo, a.title, a.body, [c.labels.bug]);
    return { fix: `#${/\/issues\/(\d+)/.exec(url)?.[1] ?? url}`, mark: 'filed' };
  } else if (a.kind === 'resume') {
    // the same path as a merge right after the audit: ship.mjs --resume in i<N> (state rebuilt from the PR when missing)
    const wt = await addWorktree(p.root, c.worktreeRoot, implWorktree(a.issue, c.defaultBranch));
    const m = await mergeAudited(wt.dir, c, c.gateCommand || readGate(p.stateDir).command || '', { ...(o.testEnv ? o.testEnv() : outsideTestEnv(c)), ...testedTreesEnv(p.stateDir, c) });
    if (m.code !== 0) {
      const why = m.code === 3 ? 'its branch conflicts with the base after a rebase' : m.code === 4 ? 'the tests fail after rebasing it' : `merging it failed (ship exit ${m.code})`;
      await sendBack(p, a.issue, why, m.output);
      return { fix: `sent #${a.issue} back to ${c.labels.ready} (ship exit ${m.code})` };
    }
    if (!m.ok || (await gh.issueState(c.repo, a.issue)) !== 'CLOSED') throw new Error(`no merge yet: ${m.output.split('\n').at(-1)?.slice(0, 160)}`);
    const shipped = await shipInfo(wt.dir);
    await gh.editLabels(c.repo, a.issue, [], [c.labels.blocked]);
    await removeWorktree(p.root, wt.dir);
    o.merged?.(shipped?.test);
    return { fix: `merged PR #${a.pr} (#${a.issue})` };
  } else {
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
  let changed = false, gateAsked = false;
  for (const a of actions) {
    if (a.kind === 'first-seen') { h.stuck![String(a.issue)] = a.at; continue; }
    if (a.kind === 'forget-seen') { delete h.stuck![String(a.issue)]; continue; }
    if (a.kind === 'request-gate') {
      // one gate run per pass, whatever the number of gate-fix issues and a reused green; the next pass decides
      if (o.repairs && o.requestGate && (gateAsked || o.requestGate())) { a.result.text += ' — gate run requested'; gateAsked = changed = true; }
      continue;
    }
    if (!o.repairs) { a.result.text += ` — ${a.would}`; continue; }
    try {
      const done = await repair(p, a, o);
      changed = true;
      a.result.mark = done?.mark ?? 'fixed';
      if (done) a.result.fix = done.fix;
      a.result.text = `${a.result.fix} (${a.result.text})`;
      if (a.kind === 'remove-label') delete h.stuck![String(a.issue)];
    } catch (e: any) {
      a.result.text += ` — repair failed: ${String(e?.message ?? e).slice(0, 200)}`;
    }
  }
  const line = healthLine(results);
  h.last = { at: new Date(now).toISOString(), line };
  writeHealth(p.stateDir, h);
  return { results, line, code: results.some((r) => r.mark === '✗') ? 1 : 0, changed };
}
