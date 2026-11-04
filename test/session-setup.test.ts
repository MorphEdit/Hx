// The worktree setup in session worktrees (src/pool.ts): every session worktree (impl, audit, triage, the PRD
// roles) is set up before its first turn, a reused impl worktree only when its last setup did not succeed; the
// {{SETUP_NOTE}} of impl, audit and triage prompts; the run-log lines; logs/setup-<name>.json; an abort during
// the setup. Real git (a local bare origin), fake gh and claude; node one-liners instead of a package manager.
import { E2E, alive, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ss-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { render } = await import('../src/state.ts');
const { readSetupRecord, setupNote, writeSetupRecord } = await import('../src/setup.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const exclude = path.join(root, '.git', 'info', 'exclude');
writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
const wtRoot = path.join(tmp, 'wt');
const logDir = path.join(stateDir, 'logs');
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wtRoot,
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, roleSkills: {}, ...extra } });

const MARKER = '.setup-marker';
const counter = path.join(tmp, 'setup-runs.txt');
const script = (name: string, body: string) => { const f = path.join(tmp, name); writeFileSync(f, body); return `node "${f}"`; };
// writes the marker (holding its cwd) and counts its runs per worktree
const OK = script('ok.js', `const fs = require('fs'), path = require('path');
fs.writeFileSync(${JSON.stringify(MARKER)}, process.cwd());
fs.appendFileSync(${JSON.stringify(counter)}, path.basename(process.cwd()) + '\\n');
console.log('installed');`);
// 25 output lines, exit 1, in the worktrees whose name starts with one of its arguments (all of them without one)
const FAIL = script('fail.js', `const p = process.argv.slice(2), name = require('path').basename(process.cwd());
if (p.length && !p.includes(name[0])) process.exit(0);
for (let i = 1; i <= 25; i++) console.log('fail line ' + i);
process.exit(1);`);
const started = path.join(tmp, 'hang-started.json');
const HANG = script('hang.js', `require('fs').writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid }));
console.log('waiting'); setTimeout(() => {}, 120e3);`);
const runs = (name: string) => existsSync(counter) ? readFileSync(counter, 'utf8').split(/\r?\n/).filter((l) => l === name).length : 0;
const setupFiles = () => existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith('setup-')) : [];
const needs = () => existsSync(path.join(fakeDir, 'need.jsonl'))
  ? readFileSync(path.join(fakeDir, 'need.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const byNum = (n: number) => read().issues.find((i: any) => i.number === n);
const issue = (n: number, labels: string[] = [L.ready], body = '') => ({ number: n, title: `task ${n}`, body, state: 'OPEN', labels });

type Prompt = { role: string; n: number; text: string };
/** Runs the pool; returns its console lines and each new session's first prompt. */
async function run(extra = {}, also?: AbortSignal, only?: number[]) {
  const before = new Set(readdirSync(fakeDir));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let rc: number;
  try {
    rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal, only }), also);
  } finally { console.log = orig; }
  const prompts: Prompt[] = [];
  for (const f of readdirSync(fakeDir).filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) {
    const text = readFileSync(path.join(fakeDir, f), 'utf8').replace(/\r\n/g, '\n');
    prompts.push({ role: /^Role: (\w+)/m.exec(text)![1], n: Number(/(?:Issue|PRD): #(\d+)/.exec(text)![1]), text });
  }
  return { rc, lines, prompts };
}
const of = (ps: Prompt[], role: string, n: number) => {
  const p = ps.filter((x) => x.role === role && x.n === n);
  assert.ok(p.length >= 1, `a ${role} prompt for #${n}`);
  return p[0].text;
};
const NOTE_START = 'The worktree setup command';

test('worktreeSetup "" and no worktreeCopy: no setup line, no setup-* file, prompts as before', E2E, async () => {
  for (const f of ['impl.md', 'audit.md', 'triage.md']) {
    const t = readFileSync(path.join(here, '..', 'prompts', f), 'utf8');
    assert.equal(t.split('{{SETUP_NOTE}}').length, 2, `${f} holds the placeholder once`);
    assert.equal(render(t, { SETUP_NOTE: '' }), t.replace('{{SETUP_NOTE}}', ''), f);
  }
  board([issue(1), issue(2, [L.bug], 'crashes TRIAGEREPRO')]);
  const { rc, lines, prompts } = await run({ audit: true });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(byNum(1).state, 'CLOSED');
  assert.ok(!lines.some((l) => /\] setup/.test(l)), lines.join('\n'));
  assert.deepEqual(setupFiles(), []);
  for (const p of prompts) assert.ok(!p.text.includes('{{SETUP_NOTE}}') && !p.text.includes(NOTE_START), p.role);
  // the lines around the placeholder follow each other as in the template without it
  assert.match(of(prompts, 'implement', 1), /processes you started\.\n\nBe economical/);
  assert.match(of(prompts, 'audit', 1), /criterion is not testable\.\n\nFAIL only/);
  assert.match(of(prompts, 'triage', 2), /outside this checkout\.\nBe economical/);
});

test('every session worktree is set up before its first turn: impl, audit, triage, gauntlet critic + reviser, decompose', E2E, async () => {
  process.env.FAKE_CLAUDE_NEED = MARKER;
  try {
    board([issue(10), issue(11, [L.bug], 'crashes TRIAGEREPRO'), issue(12, [L.prd])]);
    // only these three: the PRD's children are not built
    const { rc, lines, prompts } = await run({ audit: true, gauntlet: true, worktreeSetup: OK }, undefined, [10, 11, 12]);
    assert.equal(rc, 0, lines.join('\n'));
    const ns = needs();
    assert.ok(ns.length > 0 && ns.every((x) => x.found), JSON.stringify(ns, null, 1));
    const roles = new Set(ns.map((x) => x.role));
    for (const r of ['implement', 'audit', 'triage', 'critic', 'revise', 'decompose']) assert.ok(roles.has(r), `${r} ran: ${[...roles]}`);
    assert.equal(byNum(10).state, 'CLOSED');
    assert.equal(byNum(11).state, 'CLOSED');
    for (const name of ['i10', 'a10', 't11', 'i11', 'a11', 'p12']) {
      const rec = readSetupRecord(stateDir, name);
      assert.deepEqual({ ...rec, at: undefined }, { command: OK, ok: true, exit: 0, timedOut: false, tail: 'installed', at: undefined }, name);
      assert.match(readFileSync(path.join(logDir, `setup-${name}.log`), 'utf8'), /installed/);
    }
    assert.ok(runs('p12') >= 3, 'critic, reviser and decompose worktrees each set up');
    assert.ok(lines.some((l) => new RegExp(`\\[#10\\] setup: ${OK.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\(\\d+s\\)$`).test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /installed/.test(l)), 'the output goes only to the setup log');
    for (const p of prompts) assert.ok(!p.text.includes('{{SETUP_NOTE}}') && !p.text.includes(NOTE_START), `${p.role} #${p.n}`);
  } finally { delete process.env.FAKE_CLAUDE_NEED; }
});

test('a reused impl worktree: record ok → no setup run; record ok:false or missing → run again', E2E, async () => {
  board([issue(20), issue(21), issue(22)]);
  process.env.FAKE_CLAUDE_MODE = 'crash';
  try { await run({ worktreeSetup: OK }); } finally { delete process.env.FAKE_CLAUDE_MODE; }
  for (const n of [20, 21, 22]) {
    assert.ok(byNum(n).labels.includes(L.blocked), 'failed, worktree kept');
    assert.ok(existsSync(path.join(wtRoot, `i${n}`)));
    assert.equal(runs(`i${n}`), 1);
  }
  const r21 = readSetupRecord(stateDir, 'i21')!;
  writeSetupRecord(stateDir, 'i21', { ok: false, exit: 1, timedOut: false, aborted: false, tail: 'boom', command: r21.command, ms: 0 });
  unlinkSync(path.join(logDir, 'setup-i22.json'));
  board([issue(20), issue(21), issue(22)]);
  process.env.FAKE_CLAUDE_NEED = MARKER;
  let res;
  try { res = await run({ worktreeSetup: OK }); } finally { delete process.env.FAKE_CLAUDE_NEED; }
  assert.equal(res.rc, 0, res.lines.join('\n'));
  for (const n of [20, 21, 22]) assert.equal(byNum(n).state, 'CLOSED');
  assert.equal(runs('i20'), 1, 'record ok: not run again');
  assert.equal(runs('i21'), 2, 'record ok:false: run again');
  assert.equal(runs('i22'), 2, 'record missing: run again');
  assert.ok(!res.lines.some((l) => /\[#20\] setup/.test(l)), res.lines.join('\n'));
  assert.ok(res.lines.some((l) => /\[#21\] setup: /.test(l)) && res.lines.some((l) => /\[#22\] setup: /.test(l)));
  assert.equal(readSetupRecord(stateDir, 'i21')?.ok, true, 'overwritten');
  assert.equal(readSetupRecord(stateDir, 'i22')?.ok, true);
});

test('a failing setup: the session still starts with the note, FAILED is logged, the output is in setup-i<n>.log, the record has ok:false', E2E, async () => {
  board([issue(30)]);
  const { rc, lines, prompts } = await run({ worktreeSetup: FAIL });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(byNum(30).state, 'CLOSED', 'the session went on');
  const tail = Array.from({ length: 20 }, (_, i) => `fail line ${i + 6}`).join('\n');
  const text = of(prompts, 'implement', 30);
  assert.ok(text.includes(setupNote(FAIL, { ok: false, tail })), text);
  assert.ok(text.includes(`\`${FAIL}\` failed`) && text.includes('```\nfail line 6\n') && text.includes('fail line 25\n```'), text);
  assert.match(text, /processes you started\.\n\nThe worktree setup command [^]*\n```\nBe economical/);
  assert.ok(lines.some((l) => /\[#30\] setup FAILED \(exit 1\): fail line 6 \| .* \| fail line 25$/.test(l)), lines.join('\n'));
  const out = readFileSync(path.join(logDir, 'setup-i30.log'), 'utf8');
  assert.match(out, /fail line 1\n[^]*fail line 25/);
  const rec = readSetupRecord(stateDir, 'i30');
  assert.deepEqual({ ...rec, at: undefined }, { command: FAIL, ok: false, exit: 1, timedOut: false, tail, at: undefined });
});

test("the audit's and the triage's notes come from their own worktree's setup", E2E, async () => {
  const cmd = `${FAIL} a t`;
  board([issue(31), issue(32, [L.bug], 'crashes TRIAGEREPRO')]);
  const { rc, lines, prompts } = await run({ audit: true, worktreeSetup: cmd });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(byNum(31).state, 'CLOSED');
  assert.ok(!of(prompts, 'implement', 31).includes(NOTE_START), 'the impl worktree set up fine');
  assert.ok(lines.some((l) => /\[#31\] setup: .* \(\d+s\)$/.test(l)), lines.join('\n'));
  const audit = of(prompts, 'audit', 31);
  assert.ok(audit.includes(setupNote(cmd, readSetupRecord(stateDir, 'a31'))), audit);
  assert.match(audit, /criterion is not testable\.\nThe worktree setup command [^]*\n```\n\nFAIL only/);
  const triage = of(prompts, 'triage', 32);
  assert.ok(triage.includes(setupNote(cmd, readSetupRecord(stateDir, 't32'))), triage);
  assert.match(triage, /outside this checkout\.\nThe worktree setup command [^]*\n```\nBe economical/);
  assert.equal(readSetupRecord(stateDir, 'a31')?.ok, false);
  assert.equal(readSetupRecord(stateDir, 'i31')?.ok, true);
});

test('a hanging setup is killed after worktreeSetupMinutes; the session starts with the timed-out note', E2E, async () => {
  board([issue(40)]);
  const { rc, lines, prompts } = await run({ worktreeSetup: HANG, worktreeSetupMinutes: 0.02 });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(byNum(40).state, 'CLOSED');
  assert.ok(lines.some((l) => /\[#40\] setup FAILED \(timed out after 0\.02 min\): waiting$/.test(l)), lines.join('\n'));
  assert.ok(of(prompts, 'implement', 40).includes(setupNote(HANG, { ok: false, tail: 'waiting' })));
  const rec = readSetupRecord(stateDir, 'i40');
  assert.equal(rec?.timedOut, true);
  assert.equal(rec?.ok, false);
  assert.equal(alive(JSON.parse(readFileSync(started, 'utf8')).pid), false, 'killed');
});

test('an abort during an impl setup kills it: no record, no FAILED line, label removed, worktree kept; a later run sets it up again', E2E, async () => {
  board([issue(50)]);
  rmSync(started, { force: true });
  const ac = new AbortController();
  const wait = setInterval(() => { if (existsSync(started)) { clearInterval(wait); ac.abort(); } }, 50);
  let res;
  try { res = await run({ worktreeSetup: HANG }, ac.signal); } finally { clearInterval(wait); }
  const { lines, prompts } = res;
  assert.ok(ac.signal.aborted, 'the setup started');
  assert.equal(prompts.length, 0, 'no turn ran');
  assert.equal(readSetupRecord(stateDir, 'i50'), undefined);
  assert.ok(!existsSync(path.join(logDir, 'setup-i50.log')));
  assert.ok(!lines.some((l) => /setup FAILED/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /\[#50\] stopped — released \(.*\); worktree kept$/.test(l)), lines.join('\n'));
  assert.deepEqual(byNum(50).labels, [L.ready]);
  assert.ok(existsSync(path.join(wtRoot, 'i50')));
  await new Promise((r) => setTimeout(r, 1500)); // killTree is asynchronous on Windows
  assert.equal(alive(JSON.parse(readFileSync(started, 'utf8')).pid), false, 'killed');

  const again = await run({ worktreeSetup: OK });
  assert.equal(again.rc, 0, again.lines.join('\n'));
  assert.equal(runs('i50'), 1, 'the reused worktree had no record: set up again');
  assert.equal(readSetupRecord(stateDir, 'i50')?.ok, true);
  assert.equal(byNum(50).state, 'CLOSED');
});

test('a stale ok:true record from an earlier worktree of the same name is removed before setup: an abort leaves none, the reuse sets up again', E2E, async () => {
  // e.g. #60 was built, merged and its worktree removed; it is reopened and claimed again
  writeSetupRecord(stateDir, 'i60', { ok: true, exit: 0, timedOut: false, aborted: false, tail: 'installed', command: OK, ms: 0 });
  assert.ok(!existsSync(path.join(wtRoot, 'i60')));
  board([issue(60)]);
  rmSync(started, { force: true });
  const ac = new AbortController();
  const wait = setInterval(() => { if (existsSync(started)) { clearInterval(wait); ac.abort(); } }, 50);
  let res;
  try { res = await run({ worktreeSetup: HANG }, ac.signal); } finally { clearInterval(wait); }
  assert.ok(ac.signal.aborted, 'the setup started');
  assert.equal(res.prompts.length, 0, 'no turn ran');
  assert.equal(readSetupRecord(stateDir, 'i60'), undefined, 'the stale record is gone');
  assert.ok(existsSync(path.join(wtRoot, 'i60')), 'worktree kept');
  await new Promise((r) => setTimeout(r, 1500)); // killTree is asynchronous on Windows

  const again = await run({ worktreeSetup: OK });
  assert.equal(again.rc, 0, again.lines.join('\n'));
  assert.equal(runs('i60'), 1, 'the reused worktree was set up again');
  assert.ok(again.lines.some((l) => /\[#60\] setup: /.test(l)), again.lines.join('\n'));
  assert.equal(readSetupRecord(stateDir, 'i60')?.ok, true);
  assert.equal(byNum(60).state, 'CLOSED');
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
