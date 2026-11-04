// The dashboard page: static XSS / no-external-resource checks, the served page, and its script run against a
// minimal fake DOM with hostile strings from the board and the log.
import { E2E } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const html = readFileSync(path.join(src, 'dashboard.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dpage-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
const { serveDashboard } = await import('../src/dashboard.ts');
const { DEFAULTS } = await import('../src/config.ts');
const L = DEFAULTS.labels;
const XSS = '<img src=x onerror=alert(1)>';
const stateDir = path.join(tmp, '.hx');
mkdirSync(stateDir);
writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
  { number: 7, title: XSS, body: 'x', state: 'OPEN', labels: [L.ready] },
  { number: 8, title: `PRD ${XSS}`, body: 'p', state: 'OPEN', labels: [L.prd] },
] }));
writeFileSync(path.join(stateDir, 'run.log'), `2026-10-01T10:00:00.000Z [#7] impl: ${XSS}\n`);
const project = { root: tmp, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } };

const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });
function get(port: number, p: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let body = ''; res.setEncoding('utf8').on('data', (d) => (body += d))
        .on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    }).on('error', reject).end();
  });
}

test('src/dashboard* never uses innerHTML, outerHTML, insertAdjacentHTML or document.write', E2E, () => {
  const files = readdirSync(src).filter((f) => /^dashboard.*\.(ts|html)$/.test(f));
  assert.deepEqual(files.sort(), ['dashboard-fleet.html', 'dashboard.html', 'dashboard.ts']);
  for (const f of files) {
    const t = readFileSync(path.join(src, f), 'utf8');
    for (const w of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!t.includes(w), `${f}: ${w}`);
  }
});

test('dashboard.html loads no external resource; its only absolute URLs are github.com issue links and the SVG namespace', E2E, () => {
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /<link\b/i);
  const urls = html.match(/https?:\/\/[^\s'"`)]*/g) ?? [];
  assert.ok(urls.length > 0);
  for (const u of urls) assert.ok(u === 'https://github.com/' || u === 'http://www.w3.org/2000/svg', u);
});

test('/ with no hx run: 200 text/html with the "not running" path; a hostile title is JSON in /api/board, never in the page', E2E, async () => {
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const page = await get(d.port, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/html/);
  assert.ok(page.body.includes("'not running'"));
  const b = await get(d.port, '/api/board');
  assert.ok(b.body.includes(JSON.stringify(XSS)), 'the title travels as a JSON string');
  assert.equal(JSON.parse(b.body).board[0].title, XSS);
  assert.ok(!page.body.includes(XSS));
  const s = JSON.parse((await get(d.port, '/api/state')).body);
  assert.equal(s.runner.running, false);
});

// ---- a minimal DOM: elements, text nodes, attributes; no HTML parser at all, so markup cannot appear ----
class N { childNodes: N[] = []; parentNode: N | null = null;
  appendChild(c: N) { c.parentNode = this; this.childNodes.push(c); return c; }
  replaceChildren(...cs: N[]) { this.childNodes = []; for (const c of cs) this.appendChild(c); }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.viaTextContent = true; this.childNodes = []; this.appendChild(new T(String(v))); }
  viaTextContent = false; // set by the textContent setter
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
function page(state: object | (() => object | null), board: object | null, pathname = '/') {
  const root = new E('body');
  const ids = new Map<string, E>();
  for (const id of ['back', 'repo', 'status', 'now-body', 'board-body', 'stats-body', 'log']) ids.set(id, root.appendChild(new E('div')) as E);
  const timers: (() => void)[] = [];
  const document = {
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (t: string) => new E(t), createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (s: string) => new T(s),
    querySelectorAll: (sel: string) => root.all().filter((e) => sel === '[data-since]' && e.attrs.has('data-since')),
  };
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    const body = url === 'api/state' ? (typeof state === 'function' ? state() : state) : board;
    if (!body) throw new Error('offline');
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  vm.runInNewContext(script, { document, fetch, location: { pathname }, Node: N, setInterval: (f: () => void) => { timers.push(f); return 0; }, console });
  return { root, ids, fetched, tick: () => timers.forEach((f) => f()), flush: () => new Promise((r) => setTimeout(r, 20)) };
}
const text = (e: E) => e.textContent;
const links = (e: E) => e.all().filter((x) => x.tag === 'a').map((a) => a.getAttribute('href'));

test('the page script renders hostile strings as text, links issues by integer, and degrades on board errors', E2E, async () => {
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const state = JSON.parse((await get(d.port, '/api/state')).body);
  const board = JSON.parse((await get(d.port, '/api/board')).body);
  const p = page(state, board);
  await p.flush();
  const now = p.ids.get('now-body')!, bd = p.ids.get('board-body')!, log = p.ids.get('log')!, st = p.ids.get('stats-body')!;
  assert.match(text(now), /not running/);
  assert.ok(text(bd).includes(XSS), 'the title is shown verbatim, as text');
  assert.ok(bd.all().every((e) => e.tag !== 'img'));
  assert.ok(links(bd).includes('https://github.com/me/app/issues/7'));
  assert.ok(text(bd).includes('0/0 done'));
  assert.ok(text(log).includes(`[#7] impl: ${XSS}`));
  assert.match(text(p.ids.get('status')!), /last updated \d\d:\d\d:\d\d/);
  assert.match(text(st), /0 PASS/);
  assert.ok(text(st).includes('0 REPRODUCED · 0 NEEDS-INFO · 0 FAILED · 0 GAVE UP'), 'triage from the served payload');
  assert.equal(state.usage.byPrd, null, '/api/state came before any /api/board');
  assert.ok(text(st).includes('waiting for the board'));
  const pb = page({ ...state, usage: { ...state.usage, byPrd: [{ key: '8', tokens: 1234, turns: 2, sessions: 1, durationMs: 0 }] } }, board);
  await pb.flush();
  const stb = pb.ids.get('stats-body')!;
  assert.ok(!text(stb).includes('waiting for the board'));
  assert.ok(text(stb).includes('1,234') || text(stb).includes('1234'), text(stb));
  assert.ok(links(stb).includes('https://github.com/me/app/issues/8'));

  // running, a session, a red gate, outcomes, a board error, a non-integer issue number, a hostile repo
  const since = new Date(Date.now() - 192_000).toISOString();
  const s2 = { ...state, runner: { running: true, pid: 42, startedAt: since, uptimeMs: 3_900_000, workers: 3, paused: null, draining: true,
      rateLimit: { status: 'allowed_warning', utilization: 0.81, type: 'five_hour' } },
    sessions: [{ number: '9"><x', kind: 'impl', title: XSS, turn: 4, tokens: 5000, since, elapsedMs: 192_000 }],
    gate: { sha: 'abcdef1234567', ok: false, at: since, fixIssue: 14.7 },
    usage: { ...state.usage, byPrd: null, byDay: [{ key: '2026-10-01', tokens: 300 }, { key: '2026-10-02', tokens: 57 }] },
    outcomes: { audit: { pass: 3, fail: 1, mergedIssues: 2, avgRounds: 1.5 }, gauntlet: { rounds: 4, pass: 3, fail: 1 },
      security: { passes: 2, filed: 1 }, gate: { red: 2, recovered: 1, openRed: true, redMs: [600_000], avgRedMs: 600_000 },
      issues: { done: 2, medianMs: 3_900_000 }, triage: { reproduced: 2, needsInfo: 1, failed: 0, gaveUp: 0 }, modelMismatch: 2,
      releases: { count: 3, latest: 'v0.3.1' } } };
  const p2 = page(s2, { ...board, prds: [], board: [], error: `HTTP 502 ${XSS}` });
  await p2.flush();
  const now2 = p2.ids.get('now-body')!, st2 = p2.ids.get('stats-body')!, bd2 = p2.ids.get('board-body')!;
  for (const w of ['draining', 'pid 42', 'uptime 1h 05m', 'workers 3', 'five_hour: allowed_warning 81%', 'RED', 'abcdef1', XSS, '3m 12s'])
    assert.ok(text(now2).includes(w), w);
  assert.ok(links(now2).includes('https://github.com/me/app/issues/14'), 'the gate fix issue, coerced to an integer');
  assert.ok(links(now2).every((h) => /^https:\/\/github\.com\/me\/app\/issues\/\d+$/.test(h!)), String(links(now2)));
  assert.equal(text(bd2), `board unavailable: HTTP 502 ${XSS}`);
  for (const w of ['3 PASS', '1 FAIL', 'avg rounds 1.5', '4 rounds', '2 passes · 1 filed issues', '2 RED', 'avg RED → green 10m 00s', 'RED now',
    'median wall time 1h 05m', 'waiting for the board', '2 REPRODUCED · 1 NEEDS-INFO · 0 FAILED · 0 GAVE UP', 'model mismatch', '2 session(s) ran another model',
    'latest v0.3.1 · 3 release(s)']) assert.ok(text(st2).includes(w), w);
  const svg = st2.all().find((e) => e.tag === 'svg')!;
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.all().filter((e) => e.tag === 'rect').length, 2);

  // elapsed ticks from `since` on the client
  const el = now2.all().find((e) => e.getAttribute('data-since') === since && text(e) === '3m 12s')!;
  (el.attrs as Map<string, string>).set('data-since', new Date(Date.now() - 65_000).toISOString());
  p2.tick();
  assert.equal(text(el), '1m 05s');

  // an older payload without outcomes.triage / releases still renders the rows; a board row in status `triage` shows
  const { triage: _t, releases: _r, ...oldOutcomes } = s2.outcomes;
  const p4 = page({ ...s2, outcomes: oldOutcomes }, { ...board, board: [{ number: 21, title: 'a bug', status: 'triage', waitingOn: [] }] });
  await p4.flush();
  assert.ok(text(p4.ids.get('stats-body')!).includes('0 REPRODUCED · 0 NEEDS-INFO · 0 FAILED · 0 GAVE UP'));
  assert.ok(text(p4.ids.get('stats-body')!).includes('3 PASS'));
  assert.ok(text(p4.ids.get('stats-body')!).includes('releases'), 'no outcomes.releases: the row still renders');
  assert.ok(!text(p4.ids.get('stats-body')!).includes('release(s)'));
  const p5 = page({ ...s2, outcomes: { ...s2.outcomes, releases: { count: 0, latest: null } } }, board);
  await p5.flush();
  assert.ok(text(p5.ids.get('stats-body')!).includes('none yet'));
  assert.ok(text(p4.ids.get('board-body')!).includes('triage'));
  assert.ok(links(p4.ids.get('board-body')!).includes('https://github.com/me/app/issues/21'));

  // a repo that is not owner/name gives no links at all
  const p3 = page({ ...state, repo: 'javascript:alert(1)//x/y' }, { ...board, repo: 'javascript:alert(1)//x/y' });
  await p3.flush();
  assert.deepEqual(links(p3.ids.get('board-body')!), []);
});

test('Stats: test share, median test run, gate median and p90 set with textContent, a 14-day chart of the two series, - when missing', E2E, async () => {
  const base = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, usage: {}, outcomes: {}, log: [] };
  const time = { last24h: { share: 0.237, testRunMedian: 45_000, gateMedian: 192_000, gateP90: 3_900_000 },
    days: { from: '2026-10-07', testRun: [{ day: '2026-10-07', ms: 20_000 }, { day: '2026-10-10', ms: 10_000 }, { day: '2026-10-20', ms: 30_000 }],
      gate: [{ day: '2026-10-12', ms: 60_000 }] } };
  const p = page({ ...base, time }, null);
  await p.flush();
  const st = p.ids.get('stats-body')!;
  const v = (k: string) => st.all().find((e) => e.getAttribute('data-time') === k)!;
  assert.deepEqual(['share', 'testRunMedian', 'gateMedian', 'gateP90'].map((k) => text(v(k))), ['24%', '45s', '3m 12s', '1h 05m']);
  for (const k of ['share', 'testRunMedian', 'gateMedian', 'gateP90']) assert.ok(v(k).viaTextContent, `${k} is set with textContent`);
  assert.ok(text(st).includes('Test time'));
  const svg = st.all().find((e) => e.tag === 'svg' && /test run and gate/.test(e.getAttribute('aria-label') ?? ''))!;
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  const dots = (cls: string) => svg.all().filter((e) => e.tag === 'circle' && e.getAttribute('class') === cls);
  assert.equal(dots('test').length, 3, 'one point per day with data');
  assert.equal(dots('gate').length, 1);
  const cx = (e: E) => Number(e.getAttribute('cx'));
  assert.ok(cx(dots('test')[0]) < cx(dots('gate')[0]) && cx(dots('gate')[0]) < cx(dots('test')[2]), 'points sit on their day');
  assert.equal(svg.all().filter((e) => e.tag === 'polyline').length, 2);
  assert.ok(text(dots('gate')[0]).includes('2026-10-12') && text(dots('gate')[0]).includes('1m 00s'));
  assert.ok(svg.all().filter((e) => e.tag === 'text' || e.tag === 'title').every((e) => e.viaTextContent), 'chart text set with textContent');

  // missing values show '-'; no data in the 14 days: no chart; an older payload without time renders the same
  for (const t of [{ last24h: { share: null, testRunMedian: null, gateMedian: null, gateP90: null }, days: { from: '2026-10-07', testRun: [], gate: [] } }, undefined]) {
    const q = page({ ...base, time: t }, null);
    await q.flush();
    const sq = q.ids.get('stats-body')!;
    for (const k of ['share', 'testRunMedian', 'gateMedian', 'gateP90']) assert.equal(text(sq.all().find((e) => e.getAttribute('data-time') === k)!), '-', k);
    assert.ok(!sq.all().some((e) => e.tag === 'circle'));
    assert.ok(text(sq).includes('no test time in the last 14 days'));
  }
});

test('a failed fetch shows "offline" and keeps the last data', E2E, async () => {
  let state: object | null = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, usage: {}, outcomes: {}, log: ['kept line'] };
  const p = page(() => state, null);
  await p.flush();
  assert.equal(text(p.ids.get('log')!), 'kept line');
  assert.match(text(p.ids.get('status')!), /offline · last updated/, 'the board fetch failed');
  state = null;
  p.tick();
  await p.flush();
  assert.match(text(p.ids.get('status')!), /^offline · last updated \d\d:\d\d:\d\d$/);
  assert.equal(text(p.ids.get('log')!), 'kept line');
  assert.match(text(p.ids.get('now-body')!), /not running/);
});

test('the page fetches only relative api/ paths, so it works at / and under /repo/<k>/', E2E, async () => {
  assert.ok(!html.includes("'/api/"), "no '/api/ string remains");
  const urls = [...script.matchAll(/\b(?:fetch|getJson)\(\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
  assert.deepEqual(urls.sort(), ['api/board', 'api/state']);
  assert.doesNotMatch(script, /\b(?:fetch|getJson)\(\s*['"`]\//, 'no fetch path starts with /');
  const p = page({ repo: 'me/app', runner: { running: false }, sessions: [], gate: null, usage: {}, outcomes: {}, log: [] }, { repo: 'me/app', prds: [], board: [] });
  await p.flush();
  assert.deepEqual(p.fetched, ['api/state', 'api/board']);
});

test('a back link to ../../ shows only when the page is at /repo/<k>/', E2E, async () => {
  const s = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, usage: {}, outcomes: {}, log: [] };
  const back = (pathname: string) => { const p = page(s, null, pathname); return p.ids.get('back')! as E & { hidden?: boolean }; };
  const at = back('/repo/3/');
  assert.deepEqual(links(at), ['../../']);
  assert.equal(text(at), '← all repos');
  assert.equal(at.hidden, false);
  for (const p of ['/', '/repo/', '/repo/x/', '/repo/3', '/repo/3/api/state', '/a/repo/3/', '/repo/3//']) {
    const b = back(p);
    assert.deepEqual(b.childNodes, [], p);
    assert.notEqual(b.hidden, false, p);
  }
  assert.match(html, /<nav id="back"[^>]*\bhidden\b/, 'hidden in the markup, so plain hx dashboard looks as before');
});

// ---- the fleet page (dashboard-fleet.html), run against the same fake DOM ----
const fleetHtml = readFileSync(path.join(src, 'dashboard-fleet.html'), 'utf8');
const fleetScript = fleetHtml.slice(fleetHtml.indexOf('<script>') + 8, fleetHtml.lastIndexOf('</script>'));
function fleetPage(data: object | null | (() => object | null)) {
  const root = new E('body');
  const ids = new Map<string, E>();
  for (const id of ['status', 'fleet-body', 'repos']) ids.set(id, root.appendChild(new E('div')) as E);
  const timers: (() => void)[] = [];
  const fetched: string[] = [];
  const document = { getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (t: string) => new E(t), createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (s: string) => new T(s) };
  const fetch = async (url: string) => {
    fetched.push(url);
    const body = typeof data === 'function' ? data() : data;
    if (!body) throw new Error('offline');
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  const ctx: any = { document, fetch, Node: N, setInterval: (f: () => void) => { timers.push(f); return 0; }, console };
  vm.runInNewContext(fleetScript, ctx);
  return { ctx, ids, fetched, tick: () => timers.forEach((f) => f()), flush: () => new Promise((r) => setTimeout(r, 20)) };
}
const cards = (p: ReturnType<typeof fleetPage>) => p.ids.get('repos')!.childNodes as E[];

test('dashboard-fleet.html: no markup sinks, no external resource, only the relative api/fleet fetch, links built from k', E2E, () => {
  for (const w of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!fleetHtml.includes(w), w);
  assert.doesNotMatch(fleetHtml, /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(fleetHtml, /@import|url\(|<link\b|<img\b|<iframe\b/i);
  for (const u of fleetHtml.match(/https?:\/\/[^\s'"`)]*/g) ?? []) assert.equal(u, 'http://www.w3.org/2000/svg');
  const urls = [...fleetScript.matchAll(/\bfetch\(\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
  assert.deepEqual(urls, ['api/fleet']);
  assert.equal([...fleetScript.matchAll(/\bfetch\(/g)].length, 1, 'no other fetch');
  assert.match(fleetScript, /href: 'repo\/' \+ r\.k \+ '\/'/);
  assert.ok(!fleetScript.includes('.href ='), 'href only via setAttribute from k');
});

test('fleet page sortRepos: running first, then by repo case-insensitively; missing / no-repo last by root; each keeps its k', E2E, () => {
  const { ctx } = fleetPage(null);
  const input = [
    { k: 0, root: 'D:/z', repo: 'me/zeta', running: false },
    { k: 1, root: 'D:/gone', repo: 'me/gone', missing: true },
    { k: 2, root: 'D:/b', repo: 'Me/Beta', running: true },
    { k: 3, root: 'D:/a', repo: 'me/alpha', running: false },
    { k: 4, root: 'D:/c', repo: null, running: true },
    { k: 5, root: 'D:/y', repo: 'me/ALPHA2', running: true },
    { k: 6, root: 'D:/aa', missing: true },
    { k: 7, root: 'D:/m', repo: 'me/Mid', running: false },
  ];
  const copy = JSON.parse(JSON.stringify(input));
  const out = ctx.sortRepos(input);
  assert.deepEqual(out.map((r: any) => r.k), [5, 2, 3, 7, 0, 6, 4, 1]);
  for (const r of out) assert.deepEqual({ ...r }, copy.find((c: any) => c.k === r.k), 'entries unchanged');
  assert.deepEqual(input.map((r) => r.k), copy.map((r: any) => r.k), 'the input array is not reordered');
  assert.equal(ctx.sortRepos([]).length, 0);
});

test('fleet page with no repos says so and names hx fleet add and hx run', E2E, async () => {
  const p = fleetPage({ at: new Date().toISOString(), fleet: { slotsInUse: 0, fleetWorkers: 2, hold: null, tokensByDay: [] }, repos: [] });
  await p.flush();
  const t = p.ids.get('repos')!.textContent;
  assert.match(t, /No repos known yet/);
  assert.ok(t.includes('hx fleet add <path>'), t);
  assert.ok(t.includes('hx run'), t);
  assert.ok(p.ids.get('fleet-body')!.textContent.includes('slots 0 / 2'));
  assert.ok(p.ids.get('fleet-body')!.textContent.includes('no usage recorded yet'));
  assert.deepEqual(p.fetched, ['api/fleet']);
});

test('fleet page: fleet line with the hold, the tokens chart, one card per repo in sorted order, hostile strings as text', E2E, async () => {
  const since = new Date(Date.now() - 192_000).toISOString();
  const until = Date.now() + 3_600_000;
  const data = { at: since, fleet: { slotsInUse: 1, fleetWorkers: 3, hold: { until, reason: `usage ${XSS}`, repo: 'me/a' },
      tokensByDay: [{ key: '2026-10-01', tokens: 1100 }, { key: '2026-10-02', tokens: 20 }, { key: '2026-10-03', tokens: 12 }] },
    repos: [
      { k: 0, root: 'D:/r/z', repo: 'me/z', missing: false, running: false, pid: null, workers: null, sessions: [], paused: null, gate: null,
        rateLimit: null, tokens: { today: 0, total: 0 }, board: null },
      { k: 1, root: `D:/r/${XSS}`, repo: XSS, missing: false, running: true, pid: 42, workers: 3, sessions: [{ issue: 2, role: 'impl', since }],
        paused: 'now', gate: { ok: false, sha: 'abcdef1234567', at: '2026-10-01T11:21:00Z' },
        rateLimit: { status: 'allowed_warning', utilization: 0.81, type: 'five_hour' }, tokens: { today: 5, total: 1234 },
        board: { ready: 1, working: 2, blocked: 3, prdsOpen: 4 } },
      { k: 2, root: 'D:/r/gone', repo: 'me/gone', missing: true },
      { k: 3, root: 'D:/r/b', repo: 'me/b', missing: false, running: false, pid: null, workers: null, sessions: [], paused: null,
        gate: { ok: true, sha: '1234567890', at: '2026-10-01T11:00:00Z' }, rateLimit: null, tokens: { today: 0, total: 9 }, board: null,
        boardError: `HTTP 502 ${XSS}` },
    ] };
  const p = fleetPage(data);
  await p.flush();
  const fb = p.ids.get('fleet-body')!;
  for (const w of ['slots 1 / 3', 'hold', new Date(until).toLocaleString(), `usage ${XSS}`, 'me/a', 'Tokens per day']) assert.ok(fb.textContent.includes(w), w);
  const svg = fb.all().find((e) => e.tag === 'svg')!;
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.all().filter((e) => e.tag === 'rect').length, 3);
  assert.ok(svg.textContent.includes('max 1,100') || svg.textContent.includes('max 1100'), svg.textContent);

  const cs = cards(p);
  assert.equal(cs.length, 4);
  assert.deepEqual(cs.map((c) => links(c)), [['repo/1/'], ['repo/3/'], ['repo/0/'], []], 'sorted, each link with its own k; missing: none');
  const [run, b, z, gone] = cs.map((c) => c.textContent);
  for (const w of [XSS, 'running', 'pid 42', 'workers 3', 'paused (now)', 'failed', 'abcdef1', 'five_hour: allowed_warning 81%',
    'tokens today 5 / total ', '#2 impl', '(3m 12s)', 'ready 1', 'working 2', 'blocked 3', 'PRDs open 4', `D:/r/${XSS}`]) assert.ok(run.includes(w), w);
  assert.ok(!run.includes('abcdef12'), 'short sha');
  assert.ok(cs.every((c) => c.all().every((e) => e.tag !== 'img')), 'no markup from strings');
  for (const w of ['not running', 'gate ok', '1234567', `board unavailable: HTTP 502 ${XSS}`]) assert.ok(b.includes(w), w);
  assert.ok(!b.includes('board not read yet'));
  assert.ok(z.includes('board not read yet') && z.includes('no run yet') && !z.includes('board unavailable'), z);
  assert.ok(!z.includes('pid') && !run.includes('board not read yet'));
  assert.ok(gone.includes('missing') && gone.includes('D:/r/gone'), gone);
  assert.match(p.ids.get('status')!.textContent, /^last updated \d\d:\d\d:\d\d$/);
});

test('fleet page: a failed fetch shows "offline" and keeps the last cards; refresh every 5 s', E2E, async () => {
  assert.match(fleetScript, /setInterval\(poll, 5000\)/);
  let data: object | null = { fleet: { slotsInUse: 0, fleetWorkers: 2 }, repos: [{ k: 0, root: 'D:/a', repo: 'me/a', running: false, tokens: {}, board: null }] };
  const p = fleetPage(() => data);
  await p.flush();
  assert.equal(cards(p).length, 1);
  data = null;
  p.tick();
  await p.flush();
  assert.match(p.ids.get('status')!.textContent, /^offline · last updated \d\d:\d\d:\d\d$/);
  assert.equal(cards(p).length, 1);
  assert.deepEqual(p.fetched, ['api/fleet', 'api/fleet']);
});
