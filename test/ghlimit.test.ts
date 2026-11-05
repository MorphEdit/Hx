// The GitHub API budget (#169, PRD #138 §A): ghlimit.ts, the fake gh's `api rate_limit`, live.json.github written by a
// runner, and the github line in hx status, hx fleet status and the dashboard. Real git, fake gh and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { classifyLimit, githubLine, parseRateLimit, type GhBudget } from '../src/ghlimit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const GH = path.join(here, 'fakes', 'gh.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ghl-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = GH;
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { rateLimit } = await import('../src/github.ts');
const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { dashboardState, serveDashboard } = await import('../src/dashboard.ts');
const { writeLive } = await import('../src/runstate.ts');
const { writeFleet } = await import('../src/fleet.ts');

const hhmm = (sec: number) => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const T1 = Math.floor(Date.UTC(2026, 10, 2, 13, 5) / 1000), T2 = T1 + 47 * 60;
const budget = (core: [number, number], graphql: [number, number]): GhBudget => ({
  core: { remaining: core[0], limit: core[1], reset: T1 }, graphql: { remaining: graphql[0], limit: graphql[1], reset: T2 }, at: '2026-11-02T12:00:00.000Z' });

test('parseRateLimit: the core and graphql buckets of gh api rate_limit; null on bad JSON or a missing bucket', E2E, () => {
  const json = JSON.stringify({ resources: { core: { limit: 5000, used: 877, remaining: 4123, reset: T1 }, graphql: { limit: 5000, remaining: 4800, reset: T2 },
    search: { limit: 30, remaining: 30, reset: T1 } }, rate: { limit: 5000, remaining: 4123, reset: T1 } });
  const b = parseRateLimit(json, new Date('2026-11-02T12:00:00.000Z'));
  assert.deepEqual(b, budget([4123, 5000], [4800, 5000]));
  assert.ok(parseRateLimit(json)!.at, 'at defaults to now');
  assert.equal(parseRateLimit('not json'), null);
  assert.equal(parseRateLimit(''), null);
  assert.equal(parseRateLimit('null'), null);
  assert.equal(parseRateLimit(JSON.stringify({ resources: { core: { limit: 5000, remaining: 1, reset: T1 } } })), null, 'no graphql');
  assert.equal(parseRateLimit(JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 1, reset: T1 } } })), null, 'no core');
  assert.equal(parseRateLimit(JSON.stringify({ resources: { core: { limit: 5000, reset: T1 }, graphql: { limit: 5000, remaining: 1, reset: T1 } } })), null, 'no remaining');
});

test('githubLine: both buckets, and the reset of the bucket with less left (a tie: core), in local HH:MM', E2E, () => {
  assert.equal(githubLine(budget([4123, 5000], [4800, 5000])), `github   core 4123/5000, graphql 4800/5000 (resets ${hhmm(T1)})`);
  assert.equal(githubLine(budget([4900, 5000], [100, 5000])), `github   core 4900/5000, graphql 100/5000 (resets ${hhmm(T2)})`);
  // the share left decides, not the count: 900/1000 (90%) is more than 4000/5000 (80%)
  assert.equal(githubLine(budget([900, 1000], [4000, 5000])), `github   core 900/1000, graphql 4000/5000 (resets ${hhmm(T2)})`);
  assert.equal(githubLine(budget([2500, 5000], [2500, 5000])), `github   core 2500/5000, graphql 2500/5000 (resets ${hhmm(T1)})`, 'tie: core');
  assert.equal(githubLine(budget([500, 1000], [2500, 5000])), `github   core 500/1000, graphql 2500/5000 (resets ${hhmm(T1)})`, 'equal shares: core');
  assert.match(githubLine(budget([1, 2], [1, 2])), /\(resets \d\d:\d\d\)$/);
});

test('classifyLimit: primary, secondary via each phrase with Retry-After, anything else null', E2E, () => {
  assert.deepEqual(classifyLimit('HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)'), { kind: 'primary' });
  assert.deepEqual(classifyLimit('GraphQL: API rate limit exceeded for user ID 1.'), { kind: 'primary' });
  assert.deepEqual(classifyLimit('api rate limit exceeded'), { kind: 'primary' });
  assert.deepEqual(classifyLimit('HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'), { kind: 'secondary' });
  assert.deepEqual(classifyLimit('HTTP 429: You have exceeded a Secondary Rate Limit'), { kind: 'secondary' });
  assert.deepEqual(classifyLimit('You have triggered an abuse detection mechanism.'), { kind: 'secondary' });
  assert.deepEqual(classifyLimit('HTTP 403: You have triggered an Abuse Detection mechanism\nRetry-After: 60'), { kind: 'secondary', retryAfter: 60 });
  assert.deepEqual(classifyLimit('HTTP 403: secondary rate limit\nretry-after: 2\n'), { kind: 'secondary', retryAfter: 2 });
  assert.deepEqual(classifyLimit('RETRY-AFTER:2 then: You have exceeded a secondary rate limit'), { kind: 'secondary', retryAfter: 2 });
  assert.equal(classifyLimit('HTTP 401: Bad credentials'), null);
  assert.equal(classifyLimit('HTTP 502: Bad Gateway'), null);
  assert.equal(classifyLimit('HTTP 404: Not Found'), null);
  assert.equal(classifyLimit('HTTP 403: Resource not accessible by integration'), null);
  assert.equal(classifyLimit('error connecting to api.github.com'), null);
  assert.equal(classifyLimit('To get started with GitHub CLI, please run:  gh auth login'), null);
  assert.equal(classifyLimit(''), null);
});

// a board with a rate limit in it; RL: core has the lower share left, so its reset shows
const RL = { core: { limit: 5000, remaining: 1200, reset: T1 }, graphql: { limit: 5000, remaining: 4800, reset: T2 } };
const LINE = `github   core 1200/5000, graphql 4800/5000 (resets ${hhmm(T1)})`;
const RL2 = { core: { limit: 5000, remaining: 4900, reset: T1 }, graphql: { limit: 5000, remaining: 300, reset: T2 } };
const LINE2 = `github   core 4900/5000, graphql 300/5000 (resets ${hhmm(T2)})`;
const writeBoard = (file: string, extra: object = {}) => writeFileSync(file, JSON.stringify({ comments: [], prs: [], issues: [], ...extra }));

test('fake gh: api rate_limit answers from state.rateLimit, defaults to 5000/5000, fails with rateLimitFails; github.rateLimit reads it', E2E, async () => {
  writeBoard(stateFile, { rateLimit: RL });
  const r = spawnSync(process.execPath, [GH, 'api', 'rate_limit'], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { resources: RL });
  const b = await rateLimit();
  assert.deepEqual({ core: b!.core, graphql: b!.graphql }, RL);

  writeBoard(stateFile);
  const d = await rateLimit();
  const soon = Date.now() / 1000 + 3600;
  for (const k of ['core', 'graphql'] as const) {
    assert.equal(d![k].limit, 5000); assert.equal(d![k].remaining, 5000);
    assert.ok(Math.abs(d![k].reset - soon) < 120, `${k} resets about an hour from now`);
  }

  writeBoard(stateFile, { rateLimit: RL, rateLimitFails: true });
  assert.equal(spawnSync(process.execPath, [GH, 'api', 'rate_limit'], { encoding: 'utf8' }).status, 1);
  assert.equal(await rateLimit(), null, 'a failed read is null, never a throw');
});

function app(name: string): string {
  const r = path.join(tmp, name);
  saveConfig(path.join(r, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  return r;
}
function hx(args: string[], cwd: string, board: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: GH, HX_FAKE_STATE: board, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lines = (out: string) => out.split(/\r?\n/);

test('hx status with no runner up prints the github line from its own read, before model; rateLimitFails: no line, same exit code', E2E, () => {
  const root = app('status');
  const b = path.join(tmp, 'status-board.json');
  writeBoard(b, { rateLimit: RL });
  const ok = hx(['status'], root, b);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /^runner {3}not running$/m);
  const ls = lines(ok.out);
  const gi = ls.indexOf(LINE), mi = ls.findIndex((l) => l.startsWith('model '));
  assert.ok(gi >= 0, ok.out);
  assert.equal(mi, gi + 1, 'the github line comes right before model');

  writeBoard(b, { rateLimit: RL2 });
  assert.ok(lines(hx(['status'], root, b).out).includes(LINE2), 'graphql has less left: its reset shows');

  writeBoard(b, { rateLimit: RL, rateLimitFails: true });
  const bad = hx(['status'], root, b);
  assert.equal(bad.code, ok.code, bad.out + bad.err);
  assert.doesNotMatch(bad.out, /^github /m);
  assert.match(bad.out, /^model /m);
});

test('hx status with a runner up still prints the github line from its own read', E2E, () => {
  const root = app('status-live');
  const b = path.join(tmp, 'status-live-board.json');
  writeBoard(b, { rateLimit: RL });
  writeLive(path.join(root, '.hx'), { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/status-live', workers: 1, sessions: [],
    github: budget([1, 5000], [1, 5000]) });
  const r = hx(['status'], root, b);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^runner {3}running/m);
  assert.deepEqual(lines(r.out).filter((l) => l.startsWith('github ')), [LINE]);
});

test('hx fleet status with two repos prints the github line exactly once, after the per-repo sections, next to the fleet line', E2E, () => {
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const a = app('alpha'), bb = app('beta');
  const before = process.env.HX_HOME;
  process.env.HX_HOME = home;
  try { writeFleet({ repos: [{ root: a }, { root: bb }], workers: 3 }); } finally {
    if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before;
  }
  const b = path.join(home, 'board.json');
  writeBoard(b, { rateLimit: RL });
  const r = hx(['fleet', 'status'], tmp, b, { HX_HOME: home });
  assert.equal(r.code, 0, r.out + r.err);
  const ls = lines(r.out);
  assert.deepEqual(ls.filter((l) => l.startsWith('github ')), [LINE], r.out);
  const gi = ls.indexOf(LINE), fi = ls.findIndex((l) => l.startsWith('fleet '));
  assert.ok(gi > ls.findIndex((l) => l.startsWith('== me/beta')), 'after the per-repo sections');
  assert.equal(fi, gi + 1, 'right before the fleet line');

  writeBoard(b, { rateLimit: RL, rateLimitFails: true });
  const bad = hx(['fleet', 'status'], tmp, b, { HX_HOME: home });
  assert.equal(bad.code, 0, bad.out + bad.err);
  assert.doesNotMatch(bad.out, /^github /m);
  assert.match(bad.out, /^fleet /m);
});

// a runner on a real repo
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'run');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
const readLiveFile = () => { try { return JSON.parse(readFileSync(path.join(stateDir, 'live.json'), 'utf8')); } catch { return null; } };
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false } });
async function watchUntilIdle(): Promise<{ live: any; lines: string[] }> {
  rmSync(stateDir, { recursive: true, force: true });
  const stop = new AbortController();
  let live: any = null;
  const out: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { out.push(String(m)); if (!live && /board empty/.test(String(m))) { live = readLiveFile(); stop.abort(); } };
  try { await pooled((signal) => runPool(project() as any, { workers: 1, watch: true, dryRun: false, signal }), stop.signal); } finally { console.log = orig; }
  return { live, lines: out };
}

test('hx run: live.json.github holds the budget read from gh; a failed read never stops the run', E2E, async () => {
  writeBoard(stateFile, { rateLimit: RL });
  const r = await watchUntilIdle();
  assert.ok(r.live, r.lines.join('\n'));
  assert.deepEqual({ core: r.live.github.core, graphql: r.live.github.graphql }, RL);
  assert.ok(!Number.isNaN(Date.parse(r.live.github.at)));

  writeBoard(stateFile, { rateLimit: RL, rateLimitFails: true });
  const f = await watchUntilIdle();
  assert.ok(f.live, f.lines.join('\n'));
  assert.equal(f.live.github, undefined, 'no read yet: no github in live.json');
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
async function render(state: any): Promise<E> {
  const ids = new Map<string, E>();
  for (const id of ['back', 'repo', 'status', 'waiting-body', 'now-body', 'board-body', 'stats-body', 'log']) ids.set(id, new E('div'));
  const document = { getElementById: (id: string) => ids.get(id) ?? null, createElement: (t: string) => new E(t),
    createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (x: string) => new T(x), querySelectorAll: () => [] };
  const fetchFake = async (url: string) => ({ ok: true, status: 200, json: async () => (url.endsWith('api/state') ? state : { prds: [], board: [] }) });
  vm.runInNewContext(script, { document, fetch: fetchFake, location: { pathname: '/' }, Node: N, setInterval: () => 0, console });
  await new Promise((r) => setTimeout(r, 20));
  return ids.get('now-body')!;
}
const spans = (e: E) => e.all().filter((x) => x.tag === 'span').map((x) => x.textContent);

const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });

test('dashboard: the Now section shows the github line from live.json.github, and none without it', E2E, async () => {
  const dash = path.join(tmp, 'dash');
  const sd = path.join(dash, '.hx');
  mkdirSync(sd, { recursive: true });
  const proj = { root: dash, stateDir: sd, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-dash') } };
  const gb = budget([1200, 5000], [4800, 5000]);
  const line = githubLine(gb);
  const up = (extra: object) => writeLive(sd, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [], ...extra });

  up({ github: gb });
  const s = dashboardState(proj as any, () => ({})) as any;
  assert.equal(s.runner.github.line, line);
  assert.deepEqual(s.runner.github.core, gb.core);

  const d = await serveDashboard(proj as any, { port: 0 });
  servers.push(d);
  const state = await (await fetch(`${d.url}api/state`)).json();
  assert.equal(state.runner.github.line, line);
  const now = await render(state);
  assert.ok(spans(now).includes(line), JSON.stringify(spans(now)));
  // text only: a hostile line is a text node
  const XSS = '<img src=x onerror=alert(1)>';
  const hostile = await render({ ...state, runner: { ...state.runner, github: { line: XSS } } });
  assert.ok(spans(hostile).includes(XSS));
  assert.ok(hostile.all().every((e) => e.tag !== 'img'));

  up({});
  assert.equal((dashboardState(proj as any, () => ({})) as any).runner.github, null);
  const none = await (await fetch(`${d.url}api/state`)).json();
  assert.equal(none.runner.github, null);
  assert.ok(!spans(await render(none)).some((l) => l.startsWith('github ')));
});
