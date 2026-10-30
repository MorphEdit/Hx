#!/usr/bin/env node
// ship.mjs — the end of every implementation session in one call, so an agent spends one tool call
// (and one round of context) on it instead of five or six:
//   commit everything → rebase on origin/<base> → run the tests → push → open or reuse the PR →
//   squash-merge → delete the branch → close the issue
//
//   node ship.mjs --repo owner/name --base main --issue 12 --title "feat: add x" --test "npm test"
//
// With an auditor in the loop the routine is split in two:
//   --no-merge  stops after the PR is open, prints `READY #<issue> PR #<pr>`, and remembers its
//               arguments in the worktree's git dir (hx-ship.json)
//   --resume    run later by hx itself once the audit passed: the remembered arguments, then
//               rebase → test → push → merge → close (a base that moved meanwhile is re-tested)
//
// Exit codes, each with a one-line reason on stderr:
//   0 shipped · 2 bad arguments · 3 rebase conflict (rebase aborted; resolve by hand, then re-run)
//   4 tests failed on the rebased branch (output tail printed) · 5 a git/gh step failed
import { spawnSync } from 'node:child_process';

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const noMerge = args.includes('--no-merge');
const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim();
const stateFile = path.join(gitDir || '.', 'hx-ship.json');
let saved = {};
if (args.includes('--resume')) {
  try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { console.error(`ship: --resume: no ${stateFile}; run ship --no-merge first`); process.exit(2); }
}
const repo = opt('repo') ?? saved.repo, base = opt('base') ?? saved.base ?? 'main', issue = opt('issue') ?? saved.issue,
  title = opt('title') ?? saved.title, testCmd = opt('test') ?? saved.test;
if (!repo || !issue || !title || !testCmd) {
  console.error('usage: ship.mjs --repo owner/name --base main --issue N --title "type: summary" --test "<test command>" [--no-merge | --resume]');
  process.exit(2);
}

// gh can be swapped (HX_GH_BIN, as in hx itself); a .js/.mjs one runs under this node
const GH = process.env.HX_GH_BIN || 'gh';
const run = (cmd, a, opts = {}) => {
  if (cmd === 'gh' && /\.m?js$/i.test(GH)) [cmd, a] = [process.execPath, [GH, ...a]];
  else if (cmd === 'gh') cmd = GH;
  return spawnSync(cmd, a, { encoding: 'utf8', ...opts });
};
const ok = (cmd, a, step) => {
  const r = run(cmd, a);
  if (r.status !== 0) { console.error(`ship: ${step} failed: ${(r.stderr || r.stdout || '').trim().slice(-800)}`); process.exit(5); }
  return r.stdout.trim();
};
const say = (m) => console.log(`ship: ${m}`);

const branch = ok('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 'reading the branch');
if (branch === base) { console.error(`ship: on ${base}; run from the issue branch`); process.exit(2); }

// 1. commit whatever is left
ok('git', ['add', '-A'], 'git add');
if (run('git', ['diff', '--cached', '--quiet']).status !== 0) {
  ok('git', ['commit', '-q', '-m', `${title} (closes #${issue})`], 'git commit');
  say('committed');
}

// 2. rebase on the current base: other workers merge while this one works
ok('git', ['fetch', '-q', 'origin', base], 'git fetch');
const rb = run('git', ['rebase', `origin/${base}`]);
if (rb.status !== 0) {
  const files = run('git', ['diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean);
  run('git', ['rebase', '--abort']);
  console.error(`ship: rebase on origin/${base} conflicts in: ${files.join(', ') || '(unknown)'} — rebase aborted. ` +
    `Run \`git rebase origin/${base}\`, resolve, \`git rebase --continue\`, then run ship again.`);
  process.exit(3);
}

// 3. the tests, on exactly what will be merged
const t = run(testCmd, [], { shell: true });
if (t.status !== 0) {
  console.error(`ship: tests failed after rebasing on origin/${base} (\`${testCmd}\`):\n${(t.stdout + t.stderr).trim().split('\n').slice(-40).join('\n')}`);
  process.exit(4);
}
say('tests pass');

// 4. push, PR, merge, clean up, close
ok('git', ['push', '-q', '--force-with-lease', '-u', 'origin', `HEAD:${branch}`], 'git push');
let pr = ok('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number'], 'gh pr list');
if (!pr) {
  const url = ok('gh', ['pr', 'create', '-R', repo, '--base', base, '--head', branch, '--title', title, '--body', `Closes #${issue}`], 'gh pr create');
  pr = /\/pull\/(\d+)/.exec(url)?.[1] ?? '';
}
if (noMerge) {
  writeFileSync(stateFile, JSON.stringify({ repo, base, issue, title, test: testCmd, pr }, null, 2));
  console.log(`READY #${issue} PR #${pr}`);
  process.exit(0);
}
const m = run('gh', ['pr', 'merge', pr, '-R', repo, '--squash']);
if (m.status !== 0) {
  // some repos only allow auto-merge
  const a = run('gh', ['pr', 'merge', pr, '-R', repo, '--squash', '--auto']);
  if (a.status !== 0) { console.error(`ship: merging PR #${pr} failed: ${(m.stderr + a.stderr).trim().slice(-800)}`); process.exit(5); }
  console.log(`AUTO-MERGE set on PR #${pr}: #${issue} closes when it merges`);
  process.exit(0);
}
say(`PR #${pr} merged`);
run('git', ['push', '-q', 'origin', '--delete', branch]); // gh's --delete-branch fails in a worktree whose base is checked out elsewhere
const state = run('gh', ['issue', 'view', issue, '-R', repo, '--json', 'state', '-q', '.state']).stdout.trim();
if (state !== 'CLOSED') ok('gh', ['issue', 'close', issue, '-R', repo], 'gh issue close');
console.log(`SHIPPED #${issue} via PR #${pr}`);
