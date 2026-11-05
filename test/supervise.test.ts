// hx supervise restarts a crashed runner; hx service registers it at logon (#274).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKOFF_SECONDS, backoffFor, readSupervise, supervise, tooManyCrashes, type SuperviseOptions } from '../src/supervise.ts';
import { clearPause, setPause, writeLive } from '../src/runstate.ts';
import { parseQuery, schtasksCreate, service, serviceId, systemdUnit, taskName, taskXml, type ServiceSpec } from '../src/service.ts';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, 'fakes', 'runner.mjs');
const SCHTASKS = path.join(here, 'fakes', 'schtasks.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sup-'));
let n = 0;

/** A repo dir with .hx/, the fake runner's exit codes and how long each run stays up. */
function repo(codes: number[] = [], upMs = 0) {
  const root = path.join(tmp, `r${n++}`);
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(root, 'codes.json'), JSON.stringify(codes));
  writeFileSync(path.join(root, 'up-ms'), String(upMs));
  const lines: string[] = [];
  const opts = (o: Partial<SuperviseOptions> = {}): SuperviseOptions => ({ stateDir, root, entry: RUNNER, args: ['--workers', '2'],
    log: (l) => lines.push(l), backoffMs: [300, 600, 900, 1200], pollMs: 50, ...o });
  const runs = () => (existsSync(path.join(root, 'runs.log')) ? readFileSync(path.join(root, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, stateDir, lines, opts, runs };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('backoff: 10 s, 30 s, 60 s, then 5 min; 5 crashes inside the window give up', E2E, () => {
  const ms = BACKOFF_SECONDS.map((s) => s * 1000);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((i) => backoffFor(i, ms)), [10_000, 30_000, 60_000, 300_000, 300_000, 300_000]);
  const W = 600_000;
  assert.ok(tooManyCrashes([0, 1, 2, 3, 4], 5, W));
  assert.ok(!tooManyCrashes([0, 1, 2, 3], 5, W));
  assert.ok(!tooManyCrashes([0, 100_000, 200_000, 300_000, 600_000], 5, W), 'the first crash is out of the window');
});

test('a crash restarts the runner after the backoff, with the same arguments in the repo; exit 0 then stops it', E2E, async () => {
  const r = repo([1, 0]);
  const t0 = Date.now();
  assert.equal(await supervise(r.opts()), 0);
  const runs = r.runs();
  assert.equal(runs.length, 2);
  for (const x of runs) {
    assert.deepEqual(x.args, ['run', '--watch', '--workers', '2']);
    assert.equal(path.resolve(x.cwd), path.resolve(r.root));
  }
  assert.ok(runs[1].at - runs[0].at >= 300, `restarted after the backoff (${runs[1].at - runs[0].at} ms)`);
  assert.ok(Date.now() - t0 >= 300);
  assert.ok(r.lines.every((l) => l.startsWith('supervise: ')), r.lines.join('\n'));
  assert.ok(r.lines.some((l) => l.startsWith('supervise: started')));
  assert.ok(r.lines.includes('supervise: runner exited 1, restart in 0s'), r.lines.join('\n'));
  const s = readSupervise(r.stateDir);
  assert.equal(s.pid, undefined, 'no supervisor pid once it stopped');
  assert.match(s.last!.line, /^supervise: runner stopped \(exit 0\)/);
});

test('exit 0 → no restart, the supervisor exits', E2E, async () => {
  const r = repo([0]);
  assert.equal(await supervise(r.opts()), 0);
  assert.equal(r.runs().length, 1);
  assert.equal(r.lines.filter((l) => l.includes('not restarting')).length, 1);
});

test('a run that stayed up resets the backoff', E2E, async () => {
  const r = repo([1, 1, 0], 250);
  assert.equal(await supervise(r.opts({ backoffMs: [100, 5000], resetAfterMs: 200 })), 0);
  assert.equal(r.runs().length, 3);
  assert.equal(r.lines.filter((l) => l === 'supervise: runner exited 1, restart in 0s').length, 2, r.lines.join('\n'));
});

test('.hx/pause → no child until hx resume removes it', E2E, async () => {
  const r = repo([0]);
  setPause(r.stateDir, 'drain');
  const done = supervise(r.opts());
  await sleep(400);
  assert.equal(r.runs().length, 0, 'no child while paused');
  assert.equal(r.lines.filter((l) => l.startsWith('supervise: stopped: paused')).length, 1, r.lines.join('\n'));
  assert.ok(readSupervise(r.stateDir).pid === process.pid, 'supervise.json names the supervisor while it waits');
  clearPause(r.stateDir);
  assert.equal(await done, 0);
  assert.equal(r.runs().length, 1);
});

test('a run lock held by another live runner → no child, one log line; started once that runner is gone', E2E, async () => {
  const r = repo([0]);
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((res) => other.once('spawn', res));
  writeLive(r.stateDir, { pid: other.pid!, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  const done = supervise(r.opts());
  await sleep(500);
  assert.equal(r.runs().length, 0, 'never a second runner');
  const held = r.lines.filter((l) => l.includes(`already running (pid ${other.pid})`));
  assert.equal(held.length, 1, r.lines.join('\n'));
  assert.ok(held[0].startsWith('supervise: '));
  other.kill();
  assert.equal(await done, 0);
  assert.equal(r.runs().length, 1);
});

test('5 crashes in 10 min → gave up, exit non-zero', E2E, async () => {
  const r = repo([1, 1, 1, 1, 1, 1]);
  assert.equal(await supervise(r.opts({ backoffMs: [20] })), 1);
  assert.equal(r.runs().length, 5);
  assert.equal(r.lines.at(-1), 'supervise: gave up after 5 crashes in 10 min');
  assert.equal(readSupervise(r.stateDir).last!.line, 'supervise: gave up after 5 crashes in 10 min');
});

test('a second supervisor for the same repo does not start', E2E, async () => {
  const r = repo([0]);
  setPause(r.stateDir, 'drain');
  const first = supervise(r.opts());
  await sleep(100);
  // the first one is this process: fake another pid by writing a live one
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((res) => other.once('spawn', res));
  const f = path.join(r.stateDir, 'supervise.json');
  const saved = readFileSync(f, 'utf8');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(saved), pid: other.pid }));
  assert.equal(await supervise(r.opts()), 3);
  writeFileSync(f, saved);
  other.kill();
  clearPause(r.stateDir);
  assert.equal(await first, 0);
});

test('the dashboard state carries supervised and the last supervise line', E2E, async () => {
  const r = repo([0]);
  await supervise(r.opts());
  const p = { root: r.root, stateDir: r.stateDir, config: { ...DEFAULTS, repo: 'me/app' } };
  const s: any = dashboardState(p as any, () => ({}) as any);
  assert.equal(s.supervised.running, false);
  assert.match(s.supervised.last.line, /^supervise: runner stopped/);
  const q = repo();
  assert.equal((dashboardState({ ...p, root: q.root, stateDir: q.stateDir } as any, () => ({}) as any) as any).supervised, null);
});

// ---- hx service

const spec = (o: Partial<ServiceSpec> = {}): ServiceSpec => ({ name: 'Hx-abcd1234', root: 'D:\\code\\Hx', node: 'C:\\Program Files\\nodejs\\node.exe',
  entry: 'C:\\npm\\hx\\bin\\hx.mjs', args: ['--workers', '2'], user: 'PC\\me', ...o });

test('the task: logon trigger for the current user, no SYSTEM, no elevation, no boot trigger, hx supervise in the repo', E2E, () => {
  const x = taskXml(spec());
  assert.match(x, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\me<\/UserId><\/LogonTrigger>/);
  assert.match(x, /<Principal id="Author"><UserId>PC\\me<\/UserId><LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel><\/Principal>/);
  for (const bad of ['SYSTEM', 'HighestAvailable', 'BootTrigger', 'Password', 'S4U']) assert.ok(!x.includes(bad), bad);
  assert.equal(x.match(/<(\w+Trigger)>/g)!.join(), '<LogonTrigger>', 'the logon trigger only');
  assert.match(x, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(x, /<Arguments>C:\\npm\\hx\\bin\\hx.mjs supervise --workers 2<\/Arguments>/);
  assert.match(x, /<WorkingDirectory>D:\\code\\Hx<\/WorkingDirectory>/);
  assert.match(taskXml(spec({ entry: 'C:\\a b\\hx.mjs', root: 'D:\\x&y' })), /<Arguments>&quot;C:\\a b\\hx.mjs&quot; supervise --workers 2<\/Arguments>[\s\S]*<WorkingDirectory>D:\\x&amp;y</);
  const args = schtasksCreate('hx\\Hx-abcd1234', 'C:\\t\\task.xml');
  assert.deepEqual(args, ['/Create', '/TN', 'hx\\Hx-abcd1234', '/XML', 'C:\\t\\task.xml', '/F']);
  for (const bad of ['/RU', '/RL', '/RP', 'ONSTART', 'SYSTEM', 'HIGHEST']) assert.ok(!args.join(' ').toUpperCase().includes(bad), bad);
});

test('the task name: hx\\<repo name>-<hash of the repo path>, one per clone', E2E, () => {
  const a = serviceId('MorphEdit/Hx', 'D:\\code\\Hx'), b = serviceId('MorphEdit/Hx', 'D:\\other\\Hx');
  assert.match(a, /^Hx-[0-9a-f]{8}$/);
  assert.notEqual(a, b, 'two clones, two tasks');
  assert.equal(serviceId('MorphEdit/Hx', 'D:\\code\\Hx'), a, 'stable');
  assert.notEqual(serviceId('me/app', 'D:\\code\\Hx'), a);
  assert.equal(taskName(a), `hx\\${a}`);
});

test('hx service install / status / uninstall drive schtasks (a fake): one task, replaced on reinstall', E2E, async () => {
  const r = repo();
  const log = path.join(r.root, 'schtasks.log');
  process.env.HX_SCHTASKS_BIN = SCHTASKS;
  process.env.FAKE_SCHTASKS_LOG = log;
  const out: string[] = [];
  const o = { repo: 'me/app', root: r.root, stateDir: r.stateDir, args: ['--workers', '3'], entry: 'C:\\hx\\bin\\hx.mjs', platform: 'win32', print: (s: string) => out.push(s) };
  const name = taskName(serviceId('me/app', r.root));
  try {
    assert.equal(await service({ ...o, sub: 'status' }), 0);
    assert.match(out.at(-3)!, /not installed/);
    assert.equal(await service({ ...o, sub: 'install' }), 0);
    assert.equal(await service({ ...o, sub: 'install' }), 0);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const creates = calls.filter((c) => c.args[0] === '/Create');
    assert.equal(creates.length, 2);
    for (const c of creates) {
      assert.deepEqual(c.args.slice(0, 3), ['/Create', '/TN', name]);
      assert.equal(c.args.at(-1), '/F', 'replaces a task of the same name');
      assert.match(c.xml, /<LogonTrigger>/);
      assert.match(c.xml, /<Arguments>C:\\hx\\bin\\hx.mjs supervise --workers 3<\/Arguments>/);
      assert.ok(c.xml.includes(`<WorkingDirectory>${path.resolve(r.root)}</WorkingDirectory>`));
      assert.ok(!existsSync(c.args[4]), 'the XML file is removed');
    }
    assert.deepEqual(JSON.parse(readFileSync(log + '.tasks', 'utf8')), [name], 'one task');
    out.length = 0;
    assert.equal(await service({ ...o, sub: 'status' }), 0);
    assert.match(out[0], /installed · Ready · last run 11\/5\/2026 9:00:00 AM · last result 0/);
    assert.match(out[1], /^supervisor not running/);
    assert.match(out[2], /^runner +not running/);
    assert.equal(await service({ ...o, sub: 'uninstall' }), 0);
    assert.deepEqual(JSON.parse(readFileSync(log + '.tasks', 'utf8')), []);
    const del = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((c) => c.args[0] === '/Delete');
    assert.deepEqual(del.args, ['/Delete', '/TN', name, '/F'], 'removes only that task');
  } finally { delete process.env.HX_SCHTASKS_BIN; delete process.env.FAKE_SCHTASKS_LOG; }
});

test('hx service install on Linux and macOS prints the unit and the commands, and changes nothing', E2E, async () => {
  const r = repo();
  const log = path.join(r.root, 'schtasks.log');
  process.env.HX_SCHTASKS_BIN = SCHTASKS;
  process.env.FAKE_SCHTASKS_LOG = log;
  try {
    for (const platform of ['linux', 'darwin']) {
      const out: string[] = [];
      assert.equal(await service({ sub: 'install', repo: 'me/app', root: r.root, stateDir: r.stateDir, args: [], entry: '/opt/hx/bin/hx.mjs', platform, print: (s) => out.push(s) }), 0);
      const t = out.join('\n');
      assert.match(t, /changes nothing/);
      assert.ok(t.includes(path.resolve(r.root)), 'the repo as working directory');
      assert.ok(t.includes('supervise'));
      if (platform === 'linux') { assert.match(t, /systemctl --user enable --now hx-app-[0-9a-f]{8}\.service/); assert.match(t, /WantedBy=default\.target/); }
      else { assert.match(t, /launchctl load -w ~\/Library\/LaunchAgents\/com\.hx\.app-[0-9a-f]{8}\.plist/); assert.match(t, /<key>RunAtLoad<\/key><true\/>/); }
    }
    assert.ok(!existsSync(log), 'schtasks never ran');
  } finally { delete process.env.HX_SCHTASKS_BIN; delete process.env.FAKE_SCHTASKS_LOG; }
  assert.match(systemdUnit(spec({ root: '/home/me/app', node: '/usr/bin/node', entry: '/opt/hx/bin/hx.mjs', args: [] })), /WorkingDirectory=\/home\/me\/app\nExecStart=\/usr\/bin\/node \/opt\/hx\/bin\/hx.mjs supervise\n/);
});

test('parseQuery reads the last result and run time', E2E, () => {
  assert.deepEqual(parseQuery('Status:        Ready\r\nLast Run Time: 1/1/2026\r\nLast Result:   267011\r\n'), { status: 'Ready', lastRun: '1/1/2026', lastResult: '267011' });
});

test('README "Starting at logon" under "Stopping and resuming", and hx help, describe supervise and service', E2E, () => {
  const r = docsText();
  const start = r.indexOf('## Stopping and resuming');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  assert.ok(sec.includes('### Starting at logon'));
  for (const w of ['hx supervise', 'hx service install', 'supervise: gave up after 5 crashes in 10 min', '`supervised`', 'no elevation', 'systemd'])
    assert.ok(sec.includes(w), w);
  const h = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  for (const w of ['supervise [--workers N]', 'service install [--workers N] | uninstall | status', 'hx\\<repo>-<hash>']) assert.ok(h.stdout.includes(w), w);
});

test('hx status: supervised with the last supervise line while a supervisor runs; not running with it after', E2E, () => {
  const r = repo();
  saveConfig(r.stateDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt${n}`) } as any);
  const board = path.join(r.root, 'board.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const status = () => {
    const x = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'status'],
      { cwd: r.root, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: board } });
    assert.equal(x.status, 0, x.stdout + x.stderr);
    return x.stdout;
  };
  const at = new Date().toISOString();
  writeFileSync(path.join(r.stateDir, 'supervise.json'), JSON.stringify({ pid: process.pid, last: { at, line: 'supervise: started hx run (pid 9)' } }));
  assert.ok(status().split(/\r?\n/).includes(`supervised · pid ${process.pid} — supervise: started hx run (pid 9)`));
  writeFileSync(path.join(r.stateDir, 'supervise.json'), JSON.stringify({ last: { at, line: 'supervise: gave up after 5 crashes in 10 min' } }));
  const out = status();
  assert.doesNotMatch(out, /^supervised/m);
  assert.match(out, /^supervise not running — \d+s ago: supervise: gave up after 5 crashes in 10 min$/m);
});
