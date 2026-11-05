// A timed-out impl turn never leaves its WIP only on the local disk (#310): the checkpoint turn, then hx's own commit
// and push of `issue/<n>`, a handoff note, then agent-blocked with the worktree kept. End to end (real git with a local
// bare origin, fake gh and claude), in the plain path and in the audited loop; then saveWip on its own.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tw-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, saveWip, HANDOFF_MARKER } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
// origin rejects a push of issue/43 and issue/53 (and of issue/63, saveWip's own case)
writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/issue/43|refs/heads/issue/53|refs/heads/issue/63) echo "rejected by the test hook" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const fakeClaude = path.join(here, 'fakes', 'claude.mjs');
// 0.1 min: the fake writes its WIP within moments, then sleeps 10 min; checkpointMinutes stays at its default
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, security: false,
  turnTimeoutMinutes: 0.1, selfHeal: false, ...extra } });
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number): string[] => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body);
const ready = (n: number, body: string) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.ready], createdAt: '2026-01-01T00:00:00Z' });
const onOrigin = (n: number) => { try { return git(origin, 'rev-parse', '--verify', '-q', `refs/heads/issue/${n}`); } catch { return ''; } };
const HX_NOTE = (n: number) => `${HANDOFF_MARKER}\n**hx:** the impl turn timed out and its checkpoint left no note; the work is on branch issue/${n}.`;

async function run(extra = {}, workers = 5) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers, watch: false, dryRun: false, signal })), lines };
  } finally { console.log = orig; }
}
const workDir = (lines: string[], n: number) => lines.map((l) => new RegExp(`\\[#${n}\\] working in (.+?)( \\(resuming earlier work\\))?$`).exec(l)).find(Boolean)?.[1] ?? '';
const checkpoints = (n: number) => readUsage(stateDir).filter((r) => r.issue === n && r.role === 'checkpoint').length;
const failComment = (n: number) => commentsOn(n).find((b) => /^\*\*hx:\*\* impl stopped —/.test(b)) ?? '';

/** #b: timed out, its checkpoint pushed · b+1: the checkpoint failed · b+2: closed before the kill · b+3: push rejected · b+4: a crash */
function assertAll(b: number, lines: string[], audited: boolean) {
  const all = lines.join('\n');
  const blocked = (n: number) => {
    const i = issue(n);
    assert.ok(i.labels.includes(L.blocked) && !i.labels.includes(L.working), `#${n}: ${i.labels.join()}`);
    const dir = workDir(lines, n);
    assert.ok(dir && existsSync(path.join(dir, `wip-${n}.txt`)), `#${n}: worktree kept: ${dir}\n${all}`);
    return dir;
  };
  // the checkpoint turn committed and pushed, and wrote the note: hx added no commit and no note of its own
  {
    const n = b;
    blocked(n);
    assert.equal(checkpoints(n), 1, all);
    assert.ok(onOrigin(n), `issue/${n} on origin\n${all}`);
    assert.equal(git(origin, 'show', `issue/${n}:wip-${n}.txt`), 'half done');
    assert.equal(git(origin, 'log', '-1', '--format=%s', `issue/${n}`), 'checkpoint by agent');
    const notes = commentsOn(n).filter((c) => c.startsWith(HANDOFF_MARKER));
    assert.deepEqual(notes, [`${HANDOFF_MARKER}\nhalf done; next: finish part ${n}`]);
    assert.match(failComment(n), /impl stopped — the impl turn timed out \(agent error: turn timed out after/);
    assert.match(failComment(n), new RegExp(`The WIP is on branch \`issue/${n}\`\\.`));
    assert.doesNotMatch(failComment(n), /if it was pushed/);
  }
  // the checkpoint turn failed: hx commits, pushes and posts the note itself
  {
    const n = b + 1;
    blocked(n);
    assert.equal(checkpoints(n), 1, all);
    assert.equal(git(origin, 'log', '-1', '--format=%s', `issue/${n}`), `wip: checkpoint (#${n})`);
    assert.equal(git(origin, 'show', `issue/${n}:wip-${n}.txt`), 'half done');
    assert.deepEqual(commentsOn(n).filter((c) => c.startsWith(HANDOFF_MARKER)), [HX_NOTE(n)]);
    assert.ok(lines.some((l) => l.includes(`[#${n}] timed out: hx committed the WIP (wip: checkpoint (#${n}))`)), all);
    assert.ok(lines.some((l) => l.includes(`[#${n}] timed out: hx pushed issue/${n}`)), all);
    assert.match(failComment(n), new RegExp(`The WIP is on branch \`issue/${n}\`\\.`));
  }
  // closed when the goal ended: no checkpoint, no push, the goal ends as today. Audited: fail() (no open PR);
  // plain: the issue is closed, which is all verify() asks of an impl, so DONE
  {
    const n = b + 2;
    assert.equal(checkpoints(n), 0, all);
    assert.equal(onOrigin(n), '');
    assert.ok(!commentsOn(n).some((c) => c.startsWith(HANDOFF_MARKER)));
    assert.ok(!lines.some((l) => l.includes(`[#${n}] timed out: hx`)), all);
    if (audited) {
      assert.ok(issue(n).labels.includes(L.blocked), issue(n).labels.join());
      assert.match(failComment(n), /impl stopped — agent error: turn timed out after/);
      assert.match(failComment(n), new RegExp(`Work is on branch \`issue/${n}\` if it was pushed\\.`));
    } else {
      assert.ok(!issue(n).labels.includes(L.blocked), issue(n).labels.join());
      assert.equal(failComment(n), '');
      assert.ok(lines.some((l) => l.includes(`[#${n}] impl DONE ✓`)), all);
    }
  }
  // origin rejects the push: agent-blocked, the comment says the push failed and where the WIP is
  {
    const n = b + 3;
    const dir = blocked(n);
    assert.equal(checkpoints(n), 1, all);
    assert.equal(onOrigin(n), '');
    const fc = failComment(n);
    assert.match(fc, /the impl turn timed out \(agent error: turn timed out after [^)]*\); the push of its WIP failed: [\s\S]*rejected by the test hook/);
    assert.ok(fc.includes(`The push failed, so the WIP is only in the kept worktree \`${dir}\`.`), fc);
    assert.doesNotMatch(fc, /if it was pushed|The WIP is on branch/);
    assert.ok(!commentsOn(n).includes(HX_NOTE(n)), 'no hx note naming a branch that is not there');
  }
  // an agent error that is not a timeout: unchanged
  {
    const n = b + 4;
    blocked(n);
    assert.equal(checkpoints(n), 0, all);
    assert.equal(onOrigin(n), '');
    assert.ok(!commentsOn(n).some((c) => c.startsWith(HANDOFF_MARKER)));
    assert.match(failComment(n), /impl stopped — agent error: claude exited 3/);
    assert.match(failComment(n), new RegExp(`Work is on branch \`issue/${n}\` if it was pushed\\.`));
  }
}
const boardFrom = (b: number) => [ready(b, 'IMPLTIMEOUT'), ready(b + 1, 'IMPLTIMEOUT IMPLTIMEOUTCPFAIL'), ready(b + 2, 'IMPLTIMEOUT IMPLTIMEOUTCLOSE'),
  ready(b + 3, 'IMPLTIMEOUT'), ready(b + 4, 'IMPLCRASH')];

test('a timed-out impl turn (plain path): checkpointed, its WIP pushed to issue/<n>, a handoff note, agent-blocked, worktree kept', E2E, async () => {
  board(boardFrom(40));
  const { lines } = await run();
  assertAll(40, lines, false);
});

test('a timed-out implementer turn (audited loop): the same, and no audit runs', E2E, async () => {
  board(boardFrom(50));
  const { lines } = await run({ audit: true });
  assertAll(50, lines, true);
  assert.ok(!lines.some((l) => /\[#5\d\] audit/.test(l)), lines.join('\n'));
  assert.deepEqual(readUsage(stateDir).filter((r) => r.issue >= 50 && r.issue < 60 && r.role === 'audit'), []);
});

test('saveWip: commits only uncommitted work, pushes only when origin lacks HEAD, never forces; a rejected push is reported', E2E, async () => {
  const wt = (n: number) => {
    const d = path.join(tmp, `sw${n}`);
    git(root, 'worktree', 'add', '-q', '-b', `issue/${n}`, d, 'origin/main');
    return d;
  };
  const a = wt(61);
  assert.deepEqual(await saveWip(a, 61, 'main'), { committed: false, pushed: false }, 'nothing beyond origin/main: no push');
  assert.equal(onOrigin(61), '');
  writeFileSync(path.join(a, 'x.txt'), 'x\n');
  assert.deepEqual(await saveWip(a, 61, 'main'), { committed: true, pushed: true });
  assert.equal(git(a, 'log', '-1', '--format=%s'), 'wip: checkpoint (#61)');
  assert.equal(onOrigin(61), git(a, 'rev-parse', 'HEAD'));
  assert.equal(git(a, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/issue/61', 'pushed with -u');
  assert.deepEqual(await saveWip(a, 61, 'main'), { committed: false, pushed: false }, 'origin already has HEAD');
  // origin moved on (another clone pushed issue/61): a plain push is refused, never forced
  const b = path.join(tmp, 'sw62');
  git(tmp, 'clone', '-q', '-b', 'issue/61', origin, b);
  writeFileSync(path.join(b, 'y.txt'), 'y\n');
  git(b, 'add', '-A'); git(b, 'commit', '-q', '-m', 'elsewhere'); git(b, 'push', '-q', 'origin', 'issue/61');
  const remote = onOrigin(61);
  writeFileSync(path.join(a, 'z.txt'), 'z\n');
  const r = await saveWip(a, 61, 'main');
  assert.equal(r.committed, true);
  assert.equal(r.step, 'push');
  assert.match(r.error ?? '', /rejected|fetch first|non-fast-forward/);
  assert.equal(onOrigin(61), remote, 'origin untouched');
  const c = wt(63);
  writeFileSync(path.join(c, 'x.txt'), 'x\n');
  const rc = await saveWip(c, 63, 'main');
  assert.deepEqual([rc.committed, rc.pushed, rc.step], [true, false, 'push']);
  assert.match(rc.error ?? '', /rejected by the test hook/);
});

test('docs: the guide says a timed-out impl turn is checkpointed and its WIP pushed to issue/<n> with a handoff note', E2E, () => {
  const guide = readFileSync(path.join(here, '..', 'docs', 'guide.md'), 'utf8');
  assert.match(guide, /impl turn times out[^\n]*checkpoint[^\n]*pushed to `issue\/<n>`[^\n]*handoff/i);
});
