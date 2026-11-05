// The auto-scaled workers line (#321, PRD #315): workersLine over live.json, hx status under the runner line, the
// dashboard's /api/state runner and the Now panel rendering it as text.
import { E2E } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-wl-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));

const { workersLine } = await import('../src/load.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { dashboardState, serveDashboard } = await import('../src/dashboard.ts');
const { writeLive } = await import('../src/runstate.ts');

const base = { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 3, sessions: [] };
const READ = { ...base, autoWorkers: { target: 2, cpuPct: 88, freeMemGB: 7.9 } };
const NONE = { ...base, autoWorkers: { target: 3 } };

test('workersLine: the target over the ceiling with the CPU %, no reading yet, rounding, null without the field', E2E, () => {
  assert.equal(workersLine(READ), 'workers 2/3 (auto: cpu 88%)');
  assert.equal(workersLine(NONE), 'workers 3/3 (auto: no reading yet)');
  assert.equal(workersLine({ ...base, autoWorkers: { target: 1, cpuPct: 87.5 } }), 'workers 1/3 (auto: cpu 88%)');
  assert.equal(workersLine({ ...base, autoWorkers: { target: 1, cpuPct: 87.4 } }), 'workers 1/3 (auto: cpu 87%)');
  assert.equal(workersLine({ ...base, autoWorkers: { target: 3, cpuPct: 0 } }), 'workers 3/3 (auto: cpu 0%)');
  assert.equal(workersLine(base), null);
});

test('hx status: the workers line right under the runner line, from live.json; none without the field or a runner', E2E, () => {
  const app = path.join(tmp, 'status-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  // the config says fixed workers: the line still comes from the running runner's live.json
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-status'), workers: 5, autoWorkers: false } as any);
  const hx = () => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.split(/\r?\n/);
  };
  const after = (lines: string[]) => lines[lines.findIndex((l) => l.startsWith('runner   running')) + 1];
  writeLive(sd, READ);
  let lines = hx();
  assert.equal(after(lines), 'workers  2/3 (auto: cpu 88%)', lines.join('\n'));
  writeLive(sd, NONE);
  lines = hx();
  assert.equal(after(lines), 'workers  3/3 (auto: no reading yet)', lines.join('\n'));
  writeLive(sd, base);
  lines = hx();
  assert.ok(lines.some((l) => l.startsWith('runner   running')), lines.join('\n'));
  assert.ok(!lines.some((l) => /^workers +\d+\/\d+/.test(l)), lines.join('\n'));
  writeLive(sd, { ...READ, pid: 2 ** 30 }); // a dead runner: no line
  lines = hx();
  assert.ok(!lines.some((l) => /^workers +\d+\/\d+/.test(l)), lines.join('\n'));
});

// the minimal DOM of dashboard-page.test.ts: elements, text nodes, attributes; no HTML parser
const html = readFileSync(path.join(here, '..', 'src', 'dashboard.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
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
async function nowPanel(state: any): Promise<E> {
  const ids = new Map<string, E>();
  for (const id of ['repo', 'status', 'waiting-body', 'now-body', 'board-body', 'stats-body', 'log']) ids.set(id, new E('div'));
  const document = { getElementById: (id: string) => ids.get(id) ?? null, createElement: (t: string) => new E(t),
    createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (x: string) => new T(x), querySelectorAll: () => [] };
  const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (url === 'api/state' ? state : { prds: [], board: [] }) });
  vm.runInNewContext(script, { document, fetch: fetchFake, location: { pathname: '/' }, Node: N, setInterval: () => 0, console });
  await new Promise((r) => setTimeout(r, 20));
  return ids.get('now-body')!;
}

const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });

test('dashboard: the runner carries workersLine (null without the field); the Now panel shows it as text', E2E, async () => {
  const dash = path.join(tmp, 'dash');
  const sd = path.join(dash, '.hx');
  mkdirSync(sd, { recursive: true });
  const project = { root: dash, stateDir: sd, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-dash') } };
  const state = () => dashboardState(project as any, () => ({})) as any;
  writeLive(sd, READ);
  assert.equal(state().runner.workersLine, 'workers 2/3 (auto: cpu 88%)');
  writeLive(sd, NONE);
  assert.equal(state().runner.workersLine, 'workers 3/3 (auto: no reading yet)');
  writeLive(sd, base);
  assert.equal(state().runner.workersLine, null);
  writeLive(sd, { ...READ, pid: 2 ** 30 });
  assert.equal(state().runner.workersLine, undefined, 'no live runner: nothing');

  // the served state, rendered by the page script: the line is a text node in the runner row
  writeLive(sd, READ);
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const served = await (await fetch(`${d.url}api/state`)).json();
  assert.equal(served.runner.workersLine, 'workers 2/3 (auto: cpu 88%)');
  const spans = (n: E) => n.all().filter((e) => e.tag === 'span').map((e) => e.textContent);
  assert.ok(spans(await nowPanel(served)).includes('workers 2/3 (auto: cpu 88%)'));
  const XSS = '<img src=x onerror=alert(1)>';
  const hostile = await nowPanel({ ...served, runner: { ...served.runner, workersLine: XSS } });
  assert.ok(spans(hostile).includes(XSS), 'as text');
  assert.ok(hostile.all().every((e) => e.tag !== 'img'));
  const off = await nowPanel({ ...served, runner: { ...served.runner, workersLine: null } });
  assert.ok(!spans(off).some((s) => /^workers \d+\/\d+/.test(String(s))), JSON.stringify(spans(off)));
  rmSync(path.join(sd, 'live.json'));
});
