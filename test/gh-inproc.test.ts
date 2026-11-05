// HX_GH_INPROC (#234): the fake gh answers hx's calls (src/exec.ts) and the scripts' calls (scripts/ghwait.mjs)
// in-process, with the same answers, board changes and recorded calls as the program, saving a node start per call.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../src/exec.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const GH = path.join(here, 'fakes', 'gh.mjs');
const { gh } = await import(pathToFileURL(GH).href);

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-inp-'));
  const board = path.join(dir, 'board.json'), log = path.join(dir, 'gh.log');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [{ number: 1, title: 't', body: 'b', state: 'OPEN', labels: ['x'] }] }));
  writeFileSync(log, '');
  return { dir, board, log };
}

/** Run with HX_FAKE_STATE / HX_FAKE_GH_LOG set for the call only. */
function withBoard<T>(s: { board: string; log: string }, fn: () => T): T {
  const saved = [process.env.HX_FAKE_STATE, process.env.HX_FAKE_GH_LOG];
  process.env.HX_FAKE_STATE = s.board; process.env.HX_FAKE_GH_LOG = s.log;
  try { return fn(); } finally {
    for (const [k, v] of [['HX_FAKE_STATE', saved[0]], ['HX_FAKE_GH_LOG', saved[1]]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const CALLS: { args: string[]; input?: string }[] = [
  { args: ['issue', 'list', '--state', 'open', '--json', 'number,title,labels'] },
  { args: ['issue', 'view', '9', '--json', 'title'] }, // not found: exit 1 with gh's error
  { args: ['issue', 'comment', '1', '-R', 'me/app', '--body-file', '-'], input: 'hello\n' },
  { args: ['issue', 'edit', '1', '-R', 'me/app', '--add-label', 'y', '--remove-label', 'x'] },
  { args: ['pr', 'create', '--head', 'issue/1', '--base', 'main', '--title', 'feat: one'] },
  { args: ['issue', 'close', '1', '--reason', 'completed'] },
  { args: ['nope'] }, // unsupported: exit 1
];

test('fake gh: in-process gives the program\'s exit codes, output, board and recorded calls', E2E, () => {
  const prog = scratch(), inp = scratch();
  const viaProgram = CALLS.map(({ args, input }) => {
    const r = spawnSync(process.execPath, [GH, ...args], { encoding: 'utf8', input: input ?? '',
      env: { ...process.env, HX_FAKE_STATE: prog.board, HX_FAKE_GH_LOG: prog.log } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  });
  const viaInProcess = withBoard(inp, () => CALLS.map(({ args, input }) => gh(args, { input: () => input ?? '', inProcess: true })));
  assert.deepEqual(viaInProcess, viaProgram);
  assert.deepEqual(viaProgram.map((r) => r.code), [0, 1, 0, 0, 0, 0, 1]);
  const scrub = (b: string) => JSON.parse(readFileSync(b, 'utf8'), (k, v) => (k === 'closedAt' || k === 'createdAt' ? '' : v));
  assert.deepEqual(scrub(inp.board), scrub(prog.board));
  assert.equal(scrub(inp.board).comments[0].body, 'hello\n');
  assert.equal(readFileSync(inp.log, 'utf8'), readFileSync(prog.log, 'utf8'));
  assert.equal(readFileSync(inp.log, 'utf8').split('\n').length, CALLS.length + 1);
});

test('fake gh: a relative --body-file is read from the call\'s cwd; a slow read answers null in-process (run it as a program)', E2E, () => {
  const s = scratch();
  writeFileSync(path.join(s.dir, 'body.md'), 'from a file');
  withBoard(s, () => {
    assert.equal(gh(['issue', 'edit', '1', '--body-file', 'body.md'], { cwd: s.dir, inProcess: true }).code, 0);
    assert.equal(JSON.parse(readFileSync(s.board, 'utf8')).issues[0].body, 'from a file');
    for (const slow of [{ slowClosedState: 50 }, { slowList: { add: {}, wake: path.join(s.dir, 'w'), ms: 50 } }]) {
      writeFileSync(s.board, JSON.stringify({ comments: [], prs: [], issues: [], ...slow }));
      const calls = readFileSync(s.log, 'utf8');
      assert.equal(gh(['issue', 'list'], { inProcess: true }), null, JSON.stringify(slow));
      assert.equal(readFileSync(s.log, 'utf8'), calls, 'a call left to the program is not recorded twice');
      assert.notEqual(gh(['issue', 'list']), null, 'as a program it answers');
    }
  });
});

// a stand-in gh that tells where it ran: in-process it answers this process's pid, as a program "program"
function probe() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-inp-'));
  const file = path.join(dir, 'probe.mjs');
  writeFileSync(file, `import { pathToFileURL } from 'node:url';
export const gh = (a, { input, cwd }) => (a[0] === 'program' ? null : { code: 3, stdout: JSON.stringify({ pid: process.pid, a, input: input(), cwd }), stderr: 'e' });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write('program');
`);
  return { dir, file };
}

test('exec.run: the gh HX_GH_INPROC names answers in-process; another command, a null answer or no HX_GH_INPROC runs a program', E2E, async () => {
  const p = probe(), saved = process.env.HX_GH_INPROC;
  try {
    process.env.HX_GH_INPROC = p.file;
    const r = await run(p.file, ['issue', 'list'], { input: 'body', cwd: p.dir });
    assert.equal(r.code, 3);
    assert.equal(r.stderr, 'e');
    assert.deepEqual(JSON.parse(r.stdout), { pid: process.pid, a: ['issue', 'list'], input: 'body', cwd: p.dir });
    assert.equal((await run(p.file, ['program'])).stdout, 'program', 'null: run as a program');
    const other = path.join(p.dir, 'other.mjs');
    writeFileSync(other, readFileSync(p.file));
    assert.equal((await run(other, ['issue'])).stdout, 'program', 'another .mjs');
    delete process.env.HX_GH_INPROC;
    assert.equal((await run(p.file, ['issue'])).stdout, 'program', 'unset');
  } finally { if (saved === undefined) delete process.env.HX_GH_INPROC; else process.env.HX_GH_INPROC = saved; }
});

test('ghwait (ship.mjs, issue.mjs): the gh HX_GH_INPROC names answers in-process; a null answer or a call with its own env runs a program', E2E, () => {
  const p = probe();
  const ghwait = pathToFileURL(path.join(here, '..', 'scripts', 'ghwait.mjs')).href;
  const code = `const { ghCaller } = await import(${JSON.stringify(ghwait)});
    const gh = ghCaller('t');
    const show = (r) => ({ status: r.status, stdout: r.stdout });
    console.log(JSON.stringify({ pid: process.pid, inp: show(gh(['issue'], { input: 'x' })), prog: show(gh(['program'])),
      env: show(gh(['issue'], { env: process.env })) }));`;
  const go = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
      { encoding: 'utf8', cwd: p.dir, env: { ...process.env, HX_GH_BIN: p.file, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const on = go({ HX_GH_INPROC: p.file });
  assert.equal(on.inp.status, 3);
  assert.deepEqual(JSON.parse(on.inp.stdout), { pid: on.pid, a: ['issue'], input: 'x', cwd: p.dir });
  assert.deepEqual(on.prog, { status: 0, stdout: 'program' });
  assert.deepEqual(on.env, { status: 0, stdout: 'program' });
  assert.deepEqual(go({ HX_GH_INPROC: '' }).inp, { status: 0, stdout: 'program' });
});
