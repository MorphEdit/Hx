// autoStart (#317): hx run keeps this repo's logon task in step with the setting; hx doctor and the dashboard show it,
// hx init asks on Windows. Every schtasks call goes to the fake (test/fakes/schtasks.mjs): no test registers a real task.
import { E2E, FAKE_SCHTASKS } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoStartText, readAutoStart, serviceId, service, syncAutoStart, taskName, taskWorkingDir, taskXml, type AutoStartOptions } from '../src/service.ts';
import { checkAutoStart, doctor } from '../src/doctor.ts';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS, labelSpecs, saveConfig } from '../src/config.ts';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-as-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let n = 0;

/** A repo dir with .hx/ and its own fake schtasks log (tasks kept in log + '.tasks'). */
function repo() {
  const root = path.join(tmp, `r${++n}`), stateDir = path.join(root, '.hx');
  mkdirSync(stateDir, { recursive: true });
  const log = path.join(root, 'schtasks.log');
  process.env.FAKE_SCHTASKS_LOG = log;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const changes = () => calls().filter((c) => c.args[0] !== '/Query');
  const tasks = (): string[] => (existsSync(log + '.tasks') ? JSON.parse(readFileSync(log + '.tasks', 'utf8')) : []);
  const lines: string[] = [];
  const o = (enabled: boolean, x: Partial<AutoStartOptions> = {}): AutoStartOptions =>
    ({ enabled, repo: 'me/app', root, stateDir, entry: 'C:\\hx\\bin\\hx.mjs', platform: 'win32', log: (l) => lines.push(l), ...x });
  return { root, stateDir, log, calls, changes, tasks, lines, o, name: taskName(serviceId('me/app', root)) };
}

test('autoStart true with no task: one create call, with the XML taskXml builds, and one log line', E2E, async () => {
  const r = repo();
  try {
    const rec = await syncAutoStart(r.o(true));
    const ch = r.changes();
    assert.equal(ch.length, 1, JSON.stringify(ch));
    assert.deepEqual(ch[0].args.slice(0, 3), ['/Create', '/TN', r.name]);
    assert.equal(ch[0].args.at(-1), '/F');
    const xml = taskXml({ name: serviceId('me/app', r.root), root: path.resolve(r.root), node: process.execPath, entry: 'C:\\hx\\bin\\hx.mjs', args: [],
      user: process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username });
    assert.equal(ch[0].xml, xml, 'the same XML hx service install registers');
    assert.deepEqual(r.lines, [`autoStart: registered ${r.name}`]);
    assert.equal(rec.task, 'registered');
    assert.deepEqual(r.tasks(), [r.name]);
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('autoStart true with the task present: no call, no line', E2E, async () => {
  const r = repo();
  try {
    await syncAutoStart(r.o(true));
    r.lines.length = 0;
    const before = r.changes().length;
    const rec = await syncAutoStart(r.o(true));
    assert.equal(r.changes().length, before, 'no create or delete');
    assert.deepEqual(r.lines, [], 'a line only when something changed');
    assert.equal(rec.task, 'registered');
    // a task hx service install registered (with --workers) counts as present too
    const s = repo();
    await service({ sub: 'install', repo: 'me/app', root: s.root, stateDir: s.stateDir, args: ['--workers', '3'], entry: 'C:\\hx\\bin\\hx.mjs', platform: 'win32', print: () => {} });
    const after = s.changes().length;
    await syncAutoStart(s.o(true));
    assert.equal(s.changes().length, after);
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('autoStart true with this repo\'s task pointing at another path: registered again', E2E, async () => {
  const r = repo();
  try {
    writeFileSync(r.log + '.tasks', JSON.stringify([r.name]));
    writeFileSync(r.log + '.xml', JSON.stringify({ [r.name]: '<Task><Actions><Exec><WorkingDirectory>D:\\elsewhere\\app</WorkingDirectory></Exec></Actions></Task>' }));
    await syncAutoStart(r.o(true));
    const ch = r.changes();
    assert.equal(ch.length, 1);
    assert.equal(ch[0].args[0], '/Create');
    assert.equal(taskWorkingDir(ch[0].xml), path.resolve(r.root));
    assert.deepEqual(r.lines, [`autoStart: registered ${r.name}`]);
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('autoStart false with this repo\'s task present: one delete call for that name only; another repo\'s task stays', E2E, async () => {
  const r = repo();
  try {
    const other = taskName(serviceId('me/other', 'D:\\code\\other'));
    await syncAutoStart(r.o(true));
    writeFileSync(r.log + '.tasks', JSON.stringify([other, ...r.tasks()]));
    const before = r.changes().length;
    r.lines.length = 0;
    const rec = await syncAutoStart(r.o(false));
    const ch = r.changes().slice(before);
    assert.equal(ch.length, 1, JSON.stringify(ch));
    assert.deepEqual(ch[0].args, ['/Delete', '/TN', r.name, '/F']);
    assert.ok(r.calls().every((c) => c.args.includes(r.name)), 'no call names another task');
    assert.deepEqual(r.tasks(), [other]);
    assert.deepEqual(r.lines, [`autoStart: removed ${r.name}`]);
    assert.equal(rec.task, 'missing');
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('autoStart false with no task: no call, no line', E2E, async () => {
  const r = repo();
  try {
    await syncAutoStart(r.o(false));
    assert.deepEqual(r.changes(), []);
    assert.deepEqual(r.lines, []);
    assert.equal(readAutoStart(r.stateDir)?.task, 'missing');
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('autoStart on macOS and Linux: the unit is printed once, schtasks never runs', E2E, async () => {
  try {
    for (const platform of ['linux', 'darwin']) {
      const r = repo();
      const out: string[] = [];
      await syncAutoStart(r.o(true, { platform, print: (s) => out.push(s) }));
      await syncAutoStart(r.o(true, { platform, print: (s) => out.push(s) }));
      assert.equal(out.length, 1, 'once');
      assert.match(out[0], /changes nothing/);
      assert.match(out[0], platform === 'linux' ? /systemctl --user enable --now hx-app-[0-9a-f]{8}\.service/ : /launchctl load -w/);
      assert.ok(!existsSync(r.log), 'schtasks never ran');
      const off: string[] = [];
      await syncAutoStart(r.o(false, { platform, print: (s) => off.push(s) }));
      assert.deepEqual(off, []);
    }
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

test('the three states hx doctor shows', E2E, () => {
  assert.equal(checkAutoStart(true, 'registered').detail, 'on (task registered)');
  assert.equal(checkAutoStart(true, 'registered').mark, '✓');
  assert.equal(checkAutoStart(true, 'missing').detail, 'on (task missing — hx run will register it)');
  assert.equal(checkAutoStart(false, 'missing').detail, 'off');
  for (const c of [checkAutoStart(true, 'missing'), checkAutoStart(false, 'missing'), checkAutoStart(true, undefined)]) assert.equal(c.required, false, 'never a failure');
  assert.equal(autoStartText(false, 'registered'), 'off');
});

/** A git repo with .hx/config.json (autoStart as given) for doctor() in-process. */
function doctorRepo(autoStart?: boolean) {
  const dir = path.join(tmp, `d${++n}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  saveConfig(path.join(dir, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(dir, 'wt'),
    ...(autoStart === undefined ? {} : { autoStart }) });
  return git(dir, 'rev-parse', '--show-toplevel');
}

test('hx doctor: autoStart on (task registered), on (task missing — hx run will register it), off', E2E, async () => {
  const board = path.join(tmp, 'board-doc.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], labels: [] }));
  Object.assign(process.env, { HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: board, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '24.0.0',
    FAKE_SCHTASKS_LOG: path.join(tmp, 'doc-schtasks.log') });
  const line = async (root: string) => (await doctor({ cwd: root, platform: 'win32', skipLabels: true })).checks.find((c) => c.label === 'autoStart');
  try {
    const on = doctorRepo(true);
    assert.equal((await line(on))?.detail, 'on (task missing — hx run will register it)');
    await syncAutoStart({ enabled: true, repo: 'me/app', root: on, stateDir: path.join(on, '.hx'), entry: HX, platform: 'win32', log: () => {} });
    assert.equal((await line(on))?.detail, 'on (task registered)');
    assert.equal((await line(doctorRepo(false)))?.detail, 'off');
    assert.equal((await line(doctorRepo()))?.detail, 'off', 'the default');
    const creates = readFileSync(path.join(tmp, 'doc-schtasks.log'), 'utf8').split('\n').filter((l) => l.includes('/Create')).length;
    assert.equal(creates, 1, 'hx doctor never registers or removes');
    assert.equal((await doctor({ cwd: on, platform: 'win32', skipLabels: true, skipAutoStart: true })).checks.find((c) => c.label === 'autoStart'), undefined);
  } finally {
    for (const k of ['HX_GH_BIN', 'HX_FAKE_STATE', 'HX_RTDD_BIN', 'HX_NODE_VERSION']) delete process.env[k];
    Object.assign(process.env, FAKE_SCHTASKS);
  }
});

test('the dashboard state carries the setting and the task as hx run last found it', E2E, async () => {
  const r = repo();
  try {
    const p = { root: r.root, stateDir: r.stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: r.root, autoStart: true } };
    let s = dashboardState(p as any, () => ({})) as any;
    assert.deepEqual({ enabled: s.autoStart.enabled, task: s.autoStart.task, text: s.autoStart.text }, { enabled: true, task: null, text: 'on (not checked yet)' });
    await syncAutoStart(r.o(true));
    s = dashboardState(p as any, () => ({})) as any;
    assert.equal(s.autoStart.text, 'on (task registered)');
    assert.equal(s.autoStart.line, `autoStart: registered ${r.name}`);
    s = dashboardState({ ...p, config: { ...p.config, autoStart: false } } as any, () => ({})) as any;
    assert.equal(s.autoStart.text, 'off');
  } finally { Object.assign(process.env, FAKE_SCHTASKS); }
});

/** One `hx run` (no issue on the board) with autoStart as given, its fake schtasks log under the repo. */
function hxRun(autoStart: boolean, args: string[] = []) {
  const base = path.join(tmp, `run${++n}`);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git'), root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), pollSeconds: 1, audit: false, gate: false, selfHeal: false, autoStart });
  const board = path.join(base, 'board.json'), log = path.join(base, 'schtasks.log');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], labels: labelSpecs(DEFAULTS.labels).map((l) => l.name), issues: [] }));
  const r = spawnSync(process.execPath, [HX, 'run', '--workers', '1', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env,
    HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: board, HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'), HX_HOME: path.join(base, 'home'), FAKE_SCHTASKS_LOG: log } });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const runLog = path.join(root, '.hx', 'run.log');
  return { code: r.status, out: r.stdout + r.stderr, calls, runLog: existsSync(runLog) ? readFileSync(runLog, 'utf8') : '' };
}

test('hx run checks autoStart at its start: registers the task on Windows (a line in run.log), prints the unit elsewhere; --dry-run changes nothing', E2E, () => {
  const r = hxRun(true);
  assert.equal(r.code, 0, r.out);
  if (process.platform === 'win32') {
    assert.equal(r.calls.filter((c) => c.args[0] === '/Create').length, 1, r.out);
    assert.match(r.runLog, /autoStart: registered hx\\app-[0-9a-f]{8}/);
  } else {
    assert.equal(r.calls.length, 0);
    assert.match(r.out, /changes nothing here/);
  }
  const off = hxRun(false);
  assert.equal(off.code, 0, off.out);
  assert.equal(off.calls.filter((c) => c.args[0] !== '/Query').length, 0);
  assert.doesNotMatch(off.runLog, /autoStart:/);
  const dry = hxRun(true, ['--dry-run']);
  assert.equal(dry.code, 0, dry.out);
  assert.deepEqual(dry.calls, [], 'a dry run never touches the task');
});

test('hx init asks about autoStart on Windows and records the answer; elsewhere it does not ask', E2E, () => {
  const base = path.join(tmp, `init${++n}`);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const board = path.join(base, 'board.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const init = (answer: string) => {
    const app = path.join(base, `app${++n}`);
    git(base, 'clone', '-q', origin, app);
    git(app, 'commit', '-q', '--allow-empty', '-m', 'init');
    const r = spawnSync(process.execPath, [HX, 'init'], { cwd: app, encoding: 'utf8', input: answer,
      env: { ...process.env, HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: board, HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs') } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return { out: r.stdout, cfg: JSON.parse(readFileSync(path.join(app, '.hx', 'config.json'), 'utf8')) };
  };
  const yes = init('y\n'), no = init('n\n');
  if (process.platform === 'win32') {
    assert.match(yes.out, /Start hx at Windows logon .*\[y\/N\]/);
    assert.equal(yes.cfg.autoStart, true);
    assert.match(yes.out, /autoStart: on/);
    assert.equal(no.cfg.autoStart, false);
    assert.match(no.out, /autoStart: off/);
  } else {
    assert.doesNotMatch(yes.out, /Windows logon/);
    assert.equal(yes.cfg.autoStart, false);
  }
});

test('docs: Starting at logon describes autoStart and its default; the config table has its row', E2E, () => {
  const d = docsText();
  const start = d.indexOf('### Starting at logon');
  const sec = d.slice(start, d.indexOf('\n## ', start + 1));
  for (const w of ['`autoStart`', 'default `false`', 'autoStart: registered hx\\<id>', 'autoStart: removed hx\\<id>', 'on (task missing — hx run will register it)'])
    assert.ok(sec.includes(w), w);
  assert.match(d, /\| `autoStart` \| `false` \|/);
  assert.equal(DEFAULTS.autoStart, false);
});
