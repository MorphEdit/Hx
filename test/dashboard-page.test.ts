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
writeFileSync(path.join(stateDir, 'run.log'), `2026-10-01T10:00:00.000Z #7 impl: ${XSS}\n`);
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
  assert.deepEqual(files.sort(), ['dashboard.html', 'dashboard.ts']);
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
function page(state: object | (() => object | null), board: object | null) {
  const root = new E('body');
  const ids = new Map<string, E>();
  for (const id of ['repo', 'status', 'now-body', 'board-body', 'stats-body', 'log']) ids.set(id, root.appendChild(new E('div')) as E);
  const timers: (() => void)[] = [];
  const document = {
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (t: string) => new E(t), createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (s: string) => new T(s),
    querySelectorAll: (sel: string) => root.all().filter((e) => sel === '[data-since]' && e.attrs.has('data-since')),
  };
  const fetch = async (url: string) => {
    const body = url === '/api/state' ? (typeof state === 'function' ? state() : state) : board;
    if (!body) throw new Error('offline');
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  vm.runInNewContext(script, { document, fetch, Node: N, setInterval: (f: () => void) => { timers.push(f); return 0; }, console });
  return { root, ids, tick: () => timers.forEach((f) => f()), flush: () => new Promise((r) => setTimeout(r, 20)) };
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
  assert.ok(text(log).includes(`#7 impl: ${XSS}`));
  assert.match(text(p.ids.get('status')!), /last updated \d\d:\d\d:\d\d/);
  assert.match(text(st), /0 PASS/);
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
      security: { passes: 2, filed: [21, 22] }, gate: { red: 2, recovered: 1, openRed: true, redMs: [600_000], avgRedMs: 600_000 },
      issues: { done: 2, medianMs: 3_900_000 } } };
  const p2 = page(s2, { ...board, prds: [], board: [], error: `HTTP 502 ${XSS}` });
  await p2.flush();
  const now2 = p2.ids.get('now-body')!, st2 = p2.ids.get('stats-body')!, bd2 = p2.ids.get('board-body')!;
  for (const w of ['draining', 'pid 42', 'uptime 1h 05m', 'workers 3', 'five_hour: allowed_warning 81%', 'RED', 'abcdef1', XSS, '3m 12s'])
    assert.ok(text(now2).includes(w), w);
  assert.ok(links(now2).includes('https://github.com/me/app/issues/14'), 'the gate fix issue, coerced to an integer');
  assert.ok(links(now2).every((h) => /^https:\/\/github\.com\/me\/app\/issues\/\d+$/.test(h!)), String(links(now2)));
  assert.equal(text(bd2), `board unavailable: HTTP 502 ${XSS}`);
  for (const w of ['3 PASS', '1 FAIL', 'avg rounds 1.5', '4 rounds', '2 passes', '#21', '2 RED', 'avg RED → green 10m 00s', 'RED now',
    'median wall time 1h 05m', 'waiting for the board']) assert.ok(text(st2).includes(w), w);
  assert.ok(links(st2).includes('https://github.com/me/app/issues/22'));
  const svg = st2.all().find((e) => e.tag === 'svg')!;
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.all().filter((e) => e.tag === 'rect').length, 2);

  // elapsed ticks from `since` on the client
  const el = now2.all().find((e) => e.getAttribute('data-since') === since && text(e) === '3m 12s')!;
  (el.attrs as Map<string, string>).set('data-since', new Date(Date.now() - 65_000).toISOString());
  p2.tick();
  assert.equal(text(el), '1m 05s');

  // a repo that is not owner/name gives no links at all
  const p3 = page({ ...state, repo: 'javascript:alert(1)//x/y' }, { ...board, repo: 'javascript:alert(1)//x/y' });
  await p3.flush();
  assert.deepEqual(links(p3.ids.get('board-body')!), []);
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
