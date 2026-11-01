// The per-window budget lines (PRD #130 section E): budgetWindows / budgetLine, hx status, live.json written by a
// runner, and the dashboard's /api/state and page. Real git, fake gh and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { writeBudget } from './budget-fixture.ts';
import { budgetLine, budgetWindows, type Reading } from '../src/budget.ts';
import type { UsageRecord } from '../src/usage.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { dashboardState, serveDashboard } = await import('../src/dashboard.ts');
const { writeLive } = await import('../src/runstate.ts');
const L = DEFAULTS.labels;
const RESET = 4102444800;

/** five_hour: 13 readings rising 1% each to 85%, $0.42 between each pair (12 pairs at $0.42 per 1%);
 *  seven_day: 3 readings rising 10% each to 40%, $1 between each pair (2 pairs). */
function fixture(): { readings: Reading[]; usage: UsageRecord[] } {
  const t0 = Date.now() - 3_600_000;
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const readings: Reading[] = [], usage: UsageRecord[] = [];
  const rec = (min: number, costUsd: number): UsageRecord => ({ ts: at(min), issue: 1, role: 'impl', sessionId: `s${usage.length}`, iteration: 1,
    model: 'm', ok: true, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd, durationMs: 0, numTurns: 1 });
  for (let i = 0; i <= 12; i++) {
    readings.push({ ts: at(i), window: 'five_hour', utilization: (73 + i) / 100, resetsAt: RESET });
    if (i < 12) usage.push(rec(i + 0.5, 0.42));
  }
  for (let i = 0; i <= 2; i++) {
    readings.push({ ts: at(20 + i), window: 'seven_day', utilization: (20 + 10 * i) / 100, resetsAt: RESET });
    if (i < 2) usage.push(rec(20 + i + 0.5, 1));
  }
  return { readings, usage };
}
function writeFixture(stateDir: string): void {
  const { readings, usage } = fixture();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'usage-readings.jsonl'), readings.map((r) => JSON.stringify(r) + '\n').join(''));
  writeFileSync(path.join(stateDir, 'usage.jsonl'), usage.map((r) => JSON.stringify(r) + '\n').join(''));
}
const CAL = 'budget five_hour: 85% used, $0.42 per 1% (n=12 pairs)';
const UNCAL = 'budget seven_day: 40% used, uncalibrated (n=2 pairs, needs 5)';

test('budgetLine: the calibrated and the uncalibrated line', E2E, () => {
  assert.equal(budgetLine({ window: 'five_hour', utilization: 0.85, resetsAt: RESET, usdPerPct: 0.42, pairs: 12 }, 5), CAL);
  assert.equal(budgetLine({ window: 'five_hour', utilization: 0.85, resetsAt: RESET, pairs: 2 }, 5), 'budget five_hour: 85% used, uncalibrated (n=2 pairs, needs 5)');
  assert.equal(budgetLine({ window: 'seven_day', utilization: 0, resetsAt: RESET, pairs: 0 }, 3), 'budget seven_day: 0% used, uncalibrated (n=0 pairs, needs 3)');
});

test('budgetWindows: one entry per window with a reading, usdPerPct only once calibrated', E2E, () => {
  const { readings, usage } = fixture();
  const ws = budgetWindows(readings, usage, 5, new Date());
  assert.equal(ws.length, 2);
  assert.deepEqual(ws.map((w) => [w.window, w.utilization, w.resetsAt, w.pairs]), [['five_hour', 0.85, RESET, 12], ['seven_day', 0.4, RESET, 2]]);
  assert.ok(Math.abs(ws[0].usdPerPct! - 0.42) < 1e-9, String(ws[0].usdPerPct));
  assert.ok(!('usdPerPct' in ws[1]));
  assert.deepEqual(ws.map((w) => budgetLine(w, 5)), [CAL, UNCAL]);
  assert.deepEqual(budgetWindows([], usage, 5, new Date()), []);
  // minPairs 2: seven_day is calibrated too ($1 per 10% = $0.10 per 1%)
  assert.equal(budgetLine(budgetWindows(readings, usage, 2, new Date())[1], 2), 'budget seven_day: 40% used, $0.10 per 1% (n=2 pairs)');
});

test('budgetWindows: utilization is 0 once resetsAt has passed; the line says 0% used', E2E, () => {
  const { readings, usage } = fixture();
  const ws = budgetWindows(readings, usage, 5, new Date((RESET + 1) * 1000));
  assert.deepEqual(ws.map((w) => w.utilization), [0, 0]);
  assert.equal(ws[0].resetsAt, RESET);
  assert.equal(budgetLine(ws[0], 5), 'budget five_hour: 0% used, $0.42 per 1% (n=12 pairs)');
});

test('hx status: a calibrated line for one window, an uncalibrated line for another, with no runner up', E2E, () => {
  const app = path.join(tmp, 'status-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-status') } as any);
  const b = path.join(tmp, 'status-board.json');
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const hx = () => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8',
      env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  assert.doesNotMatch(hx(), /^budget /m, 'no readings: no budget line');
  writeFixture(sd);
  const out = hx();
  assert.match(out, /^runner {3}not running$/m);
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith('budget '));
  assert.deepEqual(lines, [CAL, UNCAL], out);
});

// a runner on a real repo
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
const liveFile = path.join(stateDir, 'live.json');

function setup(extra: Record<string, unknown> = {}) {
  writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [{ number: 1, title: 'task 1', body: '', state: 'OPEN', labels: [L.ready] }] }));
  rmSync(stateDir, { recursive: true, force: true });
  return { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...extra } };
}
async function capture(fn: () => Promise<number>, onLine = (_l: string) => {}): Promise<{ rc: number; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(String(m)); onLine(String(m)); };
  try { return { rc: await fn(), lines }; } finally { console.log = orig; }
}
const readLiveFile = () => { try { return JSON.parse(readFileSync(liveFile, 'utf8')); } catch { return null; } };

test('hx run: live.json has budget.windows (window, utilization, resetsAt, pairs, usdPerPct when calibrated) on each loop pass', E2E, async () => {
  const p = setup();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  writeBudget(stateDir, { used: 0.88, resetsAt }); // the gate skips #1: the run waits, live.json stays
  // a second, uncalibrated window
  writeFileSync(path.join(stateDir, 'usage-readings.jsonl'), JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), window: 'seven_day',
    utilization: 0.3, resetsAt }) + '\n', { flag: 'a' });
  const stop = new AbortController();
  let live: any = null;
  const onLine = (l: string) => { if (!live && /budget: not starting/.test(l)) { live = readLiveFile(); stop.abort(); } };
  const { lines } = await capture(() => pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal }), stop.signal), onLine);
  assert.ok(live, lines.join('\n'));
  const ws = live.budget.windows;
  assert.deepEqual(ws.map((w: any) => [w.window, w.utilization, w.resetsAt, w.pairs]), [['five_hour', 0.88, resetsAt, 5], ['seven_day', 0.3, resetsAt, 0]]);
  assert.ok(Math.abs(ws[0].usdPerPct - 1) < 1e-9, String(ws[0].usdPerPct));
  assert.ok(!('usdPerPct' in ws[1]));
});

test('hx run: a reading recorded mid-session refreshes live.json budget at once', E2E, async () => {
  const p = setup({ pollSeconds: 600 }); // no loop pass while the session runs
  process.env.FAKE_CLAUDE_RATES = '0.37:seven_day';
  process.env.FAKE_CLAUDE_DELAY_MS = '6000';
  const stop = new AbortController();
  let live: any = null;
  try {
    let ended = false;
    const done = capture(() => pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal }), stop.signal)).finally(() => { ended = true; });
    // the wait covers the run's startup (labels, fetch, worktree), far more than 10 s on a loaded machine;
    // it ends when the window shows up or the run ends, well inside E2E.timeout
    for (const until = Date.now() + 120_000; !live && !ended && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 100));
      const l = readLiveFile();
      if (l?.budget?.windows?.length) live = l;
    }
    stop.abort();
    await done;
  } finally { delete process.env.FAKE_CLAUDE_RATES; delete process.env.FAKE_CLAUDE_DELAY_MS; }
  assert.ok(live, 'live.json got a budget window while the session ran');
  assert.deepEqual(live.budget.windows, [{ window: 'seven_day', utilization: 0.37, resetsAt: RESET, pairs: 0 }]);
  assert.ok(live.sessions.length === 1, 'still mid-session');
});

// the dashboard
const html = readFileSync(path.join(here, '..', 'src', 'dashboard.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
// the minimal DOM of dashboard-page.test.ts: elements, text nodes, attributes; no HTML parser
class N { childNodes: N[] = []; parentNode: N | null = null;
  appendChild(c: N) { c.parentNode = this; this.childNodes.push(c); return c; }
  replaceChildren(...cs: N[]) { this.childNodes = []; for (const c of cs) this.appendChild(c); }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = []; this.appendChild(new T(String(v))); }
}
class T extends N { data: string; constructor(data: string) { super(); this.data = data; }
  override get textContent() { return this.data; } override set textContent(v: string) { this.data = v; } }
class E extends N {
  attrs = new Map<string, string>(); className = ''; scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  tag: string; ns?: string;
  constructor(tag: string, ns?: string) { super(); this.tag = tag; this.ns = ns; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  all(): E[] { return this.childNodes.flatMap((c) => (c instanceof E ? [c, ...c.all()] : [])); }
}

const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });

test('dashboard: /api/state passes the live budget windows through with their line; the page shows the line as text', E2E, async () => {
  const dash = path.join(tmp, 'dash');
  const sd = path.join(dash, '.hx');
  mkdirSync(sd, { recursive: true });
  writeFixture(sd);
  const project = { root: dash, stateDir: sd, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-dash') } };
  const { readings, usage } = fixture();
  const windows = budgetWindows(readings, usage, 5, new Date());
  writeLive(sd, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [], budget: { windows } });
  const s = dashboardState(project as any, () => ({})) as any;
  assert.deepEqual(s.runner.budget.windows.map((w: any) => [w.window, w.utilization, w.resetsAt, w.pairs, w.line]),
    [['five_hour', 0.85, RESET, 12, CAL], ['seven_day', 0.4, RESET, 2, UNCAL]]);
  assert.ok(Math.abs(s.runner.budget.windows[0].usdPerPct - 0.42) < 1e-9);

  // like rateLimit: nothing without a live runner
  writeLive(sd, { pid: 2 ** 30, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [], budget: { windows } });
  assert.equal((dashboardState(project as any, () => ({})) as any).runner.budget, undefined);

  // the served state, rendered by the page script against a minimal DOM: the lines are text nodes
  writeLive(sd, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [], budget: { windows } });
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const state = await (await fetch(`${d.url}api/state`)).json();
  assert.equal(state.runner.budget.windows[1].line, UNCAL);
  const XSS = '<img src=x onerror=alert(1)>';
  state.runner.budget.windows.push({ window: 'x', line: XSS });
  const ids = new Map<string, E>();
  for (const id of ['repo', 'status', 'now-body', 'board-body', 'stats-body', 'log']) ids.set(id, new E('div'));
  const document = { getElementById: (id: string) => ids.get(id) ?? null, createElement: (t: string) => new E(t),
    createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (x: string) => new T(x), querySelectorAll: () => [] };
  const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (url === '/api/state' ? state : { prds: [], board: [] }) });
  vm.runInNewContext(script, { document, fetch: fetchFake, Node: N, setInterval: () => 0, console });
  await new Promise((r) => setTimeout(r, 20));
  const now = ids.get('now-body')!;
  const spans = now.all().filter((e) => e.tag === 'span').map((e) => e.textContent);
  for (const l of [CAL, UNCAL, XSS]) assert.ok(spans.includes(l), `${l} in ${JSON.stringify(spans)}`);
  assert.ok(now.all().every((e) => e.tag !== 'img'));
  rmSync(path.join(sd, 'live.json'));
  assert.ok(!existsSync(path.join(sd, 'live.json')));
});
