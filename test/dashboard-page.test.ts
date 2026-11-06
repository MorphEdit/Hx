// The dashboard page: static XSS / no-external-resource checks, the served page, and its script run against a
// minimal fake DOM with hostile strings from the board and the log.
import { E2E } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { E, links, N, page as fakePage, type Payload, T, text } from './fakedom.ts';

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

// the reference's two Google Fonts <link> elements, exactly (docs/design/control-room.html)
const FONT_LINKS = ['<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;family=Space+Grotesk:wght@500;600;700&amp;display=swap" rel="stylesheet">'];
const FONT_URLS = ['https://fonts.googleapis.com', 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;family=Space+Grotesk:wght@500;600;700&amp;display=swap'];

test('dashboard.html loads only the reference\'s two Google Fonts links; its other absolute URLs are github.com issue links and the SVG namespace', E2E, () => {
  for (const l of FONT_LINKS) assert.ok(reference.includes(l), `the reference has ${l}`);
  assert.deepEqual(html.match(/<link\b[^>]*>/gi), FONT_LINKS, 'the only <link> elements are the reference\'s two');
  const rest = FONT_LINKS.reduce((t, l) => t.replace(l, ''), html);
  assert.doesNotMatch(rest, /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, 'no other external src or href');
  assert.doesNotMatch(html, /\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  const urls = html.match(/https?:\/\/[^\s'"`)]*/g) ?? [];
  assert.ok(urls.includes('https://github.com/'));
  for (const u of urls) assert.ok(u === 'https://github.com/' || u === 'http://www.w3.org/2000/svg' || FONT_URLS.includes(u), u);
});

test('every font-family names a system fallback, so the page works offline', E2E, () => {
  const fams = [...html.matchAll(/font-family\s*:\s*([^;}"]+)/gi)].map((m) => m[1].trim());
  const fonts = [...html.matchAll(/\bfont\s*:\s*([^;}"]+)/gi)].map((m) => m[1].trim()).filter((f) => f !== 'inherit');
  assert.ok(fams.length >= 4, String(fams));
  for (const f of [...fams, ...fonts]) assert.match(f, /(?:^|,)\s*(?:sans-serif|monospace|serif)\s*$/, f);
  for (const name of ['Inter', "'JetBrains Mono'", "'Space Grotesk'"]) assert.ok(fams.some((f) => f.startsWith(name)), name);
});

// every distinct hex colour of the reference, upper case: all have six digits (its three-digit #N are issue numbers)
const reference = readFileSync(path.join(here, '..', 'docs', 'design', 'control-room.html'), 'utf8');
const refHexes = [...new Set((reference.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()))];
const lightRoot = () => {
  const media = html.indexOf('@media (prefers-color-scheme: dark)');
  const m = /:root\s*\{([^}]*)\}/.exec(html.slice(0, media));
  return { at: m!.index, body: m![1], end: m!.index + m![0].length };
};
const darkRoot = () => {
  const media = html.indexOf('@media (prefers-color-scheme: dark)');
  return /^@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(html.slice(media))![1];
};
const props = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('dark theme: each reference hex is only a custom property value in :root, every one re-set for prefers-color-scheme: dark, no !important', E2E, () => {
  assert.ok(refHexes.length >= 19, String(refHexes));
  const light = lightRoot(), lp = props(light.body), dp = props(darkRoot());
  for (const h of refHexes) {
    const at = [...html.matchAll(new RegExp(h + '\\b', 'gi'))].map((m) => m.index!);
    assert.equal(at.length, 1, `${h} is written once: ${at.length}`);
    assert.ok(at[0] > light.at && at[0] < light.end, `${h} sits in the :root rule`);
    assert.ok([...lp.values()].some((v) => v.toUpperCase() === h), `${h} is the value of a custom property`);
  }
  // no colour anywhere else in the file, today's own included: no hex as a CSS or script value, no rgb() / hsl()
  const outside = html.slice(0, light.at) + html.slice(light.end).replace(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*\}\s*\}/, '');
  assert.ok(outside.length < html.length && outside.includes('<script>'));
  assert.doesNotMatch(outside, /(?:[:,('"`]\s*|\bsolid\s+)#[0-9A-Fa-f]{3,8}\b/, 'no hex colour outside the two :root rules');
  assert.doesNotMatch(html, /\brgba?\(|\bhsla?\(/i);
  assert.ok(lp.size >= refHexes.length);
  for (const k of lp.keys()) assert.ok(dp.has(k), `${k} is set again in the dark block`);
  for (const [k, v] of dp) assert.notEqual(v.toUpperCase(), lp.get(k)?.toUpperCase(), `${k} has a dark value of its own`);
  assert.doesNotMatch(html, /!important/i);
  // SVG strokes are styles, not attributes; the script's tables use the properties
  assert.doesNotMatch(html, /\bstroke="#/i);
  for (const name of ['DOT', 'LCOLOR']) assert.match(html, new RegExp(`const ${name} = \\{[^}]*var\\(--`), name);
});

// text / background pairs of the reference's roles, in both themes
const PAIRS = [['ink', 'panel'], ['ink-2', 'panel'], ['muted', 'panel'], ['muted-2', 'panel'], ['blue', 'panel'], ['blue-deep', 'panel'],
  ['orange-text', 'panel'], ['bad', 'panel'], ['ink', 'ground'], ['muted', 'ground'], ['ink', 'flow-bg'], ['muted', 'flow-bg'],
  ['ink', 'blue-select'], ['ink-2', 'blue-select'], ['muted', 'blue-select'], ['muted-2', 'blue-select'], ['blue', 'blue-select'],
  ['orange-text', 'blue-select'], ['blue-deep', 'blue-select'], ['ink-2', 'soft'], ['blue-deep', 'blue-pale'], ['ink', 'blue-pale'],
  ['orange-deep', 'orange-pale'], ['ink', 'orange-pale'], ['panel', 'blue'], ['panel', 'ink'], ['panel', 'ok'], ['panel', 'bad'],
  ['panel', 'warn'], ['panel', 'muted']];
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('every text / background pair keeps 4.5:1 in the light and the dark theme, the small grey labels included', E2E, () => {
  for (const [name, p] of [['light', props(lightRoot().body)], ['dark', props(darkRoot())]] as const) {
    for (const [fg, bg] of PAIRS) {
      const r = contrast(p.get(`--${fg}`)!, p.get(`--${bg}`)!);
      assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test('the CSP of a repo page adds only the Google Fonts origins; the fleet overview keeps its own', E2E, async () => {
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const head = (p: string) => new Promise<string>((resolve, reject) => {
    request({ host: '127.0.0.1', port: d.port, path: p, headers: { Host: `127.0.0.1:${d.port}` }, agent: false }, (res) => {
      res.resume().on('end', () => resolve(String(res.headers['content-security-policy'])));
    }).on('error', reject).end();
  });
  assert.equal(await head('/'), "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; font-src https://fonts.gstatic.com");
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

// ---- the page script against the shared fake DOM (test/fakedom.ts): no HTML parser for the script, so markup cannot appear ----
const page = (state: Payload, board: Payload, pathname = '/') => fakePage(html, state, board, pathname);

test('the page script renders hostile strings as text, links issues by integer, and degrades on board errors', E2E, async () => {
  const d = await serveDashboard(project as any, { port: 0 });
  servers.push(d);
  const state = JSON.parse((await get(d.port, '/api/state')).body);
  const board = JSON.parse((await get(d.port, '/api/board')).body);
  const p = page(state, board);
  await p.flush();
  const now = p.ids.get('now-body')!, bd = p.ids.get('board-body')!, log = p.ids.get('log')!, st = p.ids.get('stats-body')!;
  assert.match(text(now), /not running/);
  assert.match(text(now), /health no pass yet/, 'no health.json: no pass yet');
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
    health: { at: since, line: `health: 3 ✓ · fixed 1 (${XSS})` },
    usage: { ...state.usage, byPrd: null, byDay: [{ key: '2026-10-01', tokens: 300 }, { key: '2026-10-02', tokens: 57 }] },
    outcomes: { audit: { pass: 3, fail: 1, mergedIssues: 2, avgRounds: 1.5 }, gauntlet: { rounds: 4, pass: 3, fail: 1 },
      security: { passes: 2, filed: 1 }, gate: { red: 2, recovered: 1, openRed: true, redMs: [600_000], avgRedMs: 600_000 },
      issues: { done: 2, medianMs: 3_900_000 }, triage: { reproduced: 2, needsInfo: 1, failed: 0, gaveUp: 0 }, modelMismatch: 2,
      releases: { count: 3, latest: 'v0.3.1' }, health: { passes: 5, fixed: 3, filed: 2 }, selfReview: { sessions: 4, findings: 6 } } };
  const p2 = page(s2, { ...board, prds: [], board: [], error: `HTTP 502 ${XSS}` });
  await p2.flush();
  const now2 = p2.ids.get('now-body')!, st2 = p2.ids.get('stats-body')!, bd2 = p2.ids.get('board-body')!;
  for (const w of ['draining', 'pid 42', 'uptime 1h 05m', 'workers 3', 'five_hour: allowed_warning 81%', 'RED', 'abcdef1', XSS, '3m 12s'])
    assert.ok(text(now2).includes(w), w);
  assert.ok(text(now2).includes(`health health: 3 ✓ · fixed 1 (${XSS})`), 'the last health pass, as text');
  assert.ok(text(now2).includes(new Date(since).toLocaleString()), 'the last health pass time');
  assert.ok(now2.all().every((e) => e.tag !== 'img'), 'the health line is text');
  assert.ok(links(now2).includes('https://github.com/me/app/issues/14'), 'the gate fix issue, coerced to an integer');
  assert.ok(links(now2).every((h) => /^https:\/\/github\.com\/me\/app\/issues\/\d+$/.test(h!)), String(links(now2)));
  assert.equal(text(bd2), `board unavailable: HTTP 502 ${XSS}`);
  for (const w of ['3 PASS', '1 FAIL', 'avg rounds 1.5', '4 rounds', '2 passes · 1 filed issues', '2 RED', 'avg RED → green 10m 00s', 'RED now',
    'median wall time 1h 05m', 'waiting for the board', '2 REPRODUCED · 1 NEEDS-INFO · 0 FAILED · 0 GAVE UP', 'model mismatch', '2 session(s) ran another model',
    'latest v0.3.1 · 3 release(s)', '5 passes · 3 fixed · 2 filed', '4 sessions · 6 findings']) assert.ok(text(st2).includes(w), w);
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

test('a quality-bar PRD renders its status label and round / last result as text; a PRD without one shows no bar', E2E, async () => {
  const gap = `slower than Stripe ${XSS}`;
  const b = { at: new Date().toISOString(), repo: 'me/app', board: [], prds: [
    { number: 1, title: 'billing', status: 'bar', open: 0, closed: 2, waitingOn: [], qualityBar: true, bar: { round: 2, rounds: 3, result: 'lost', gap } },
    { number: 3, title: 'reports', status: 'building', open: 1, closed: 0, waitingOn: [], qualityBar: true, bar: { round: 0, rounds: 3, result: null, gap: '' } },
    { number: 5, title: 'plain', status: 'building', open: 1, closed: 0, waitingOn: [] },
  ] };
  const p = page({ repo: 'me/app', runner: { running: false }, sessions: [], gate: null, health: null, log: [],
    usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } }, b);
  await p.flush();
  const bd = p.ids.get('board-body')!;
  const rows = bd.all().filter((e) => e.tag === 'tr').map((r) => r.all().filter((c) => c.tag === 'td' || c.tag === 'th').map(text));
  assert.deepEqual(rows[0], ['PRD', 'title', 'status', 'progress', 'quality bar']);
  assert.deepEqual(rows[1].slice(2), ['quality bar', '2/2 done', `round 2/3 · last: lost — ${gap}`]);
  assert.deepEqual(rows[2].slice(2), ['building', '0/1 done', 'not run yet']);
  assert.deepEqual(rows[3].slice(2), ['building', '0/1 done', '']);
  assert.ok(bd.all().every((e) => e.tag !== 'img'), 'the gap is text');
});

test('a running hx supervise shows supervised and its last line as text; a stopped one shows not supervised', E2E, async () => {
  const at = new Date().toISOString();
  const base = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, health: null, log: [],
    usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } };
  const p = page({ ...base, supervised: { running: true, pid: 7, last: { at, line: `supervise: started hx run (pid 8) ${XSS}` } } }, null);
  await p.flush();
  const now = p.ids.get('now-body')!;
  assert.ok(text(now).includes('supervised'), text(now));
  assert.ok(text(now).includes(`supervise: started hx run (pid 8) ${XSS}`), 'the last supervise line, as text');
  assert.ok(now.all().every((e) => e.tag !== 'img'));
  const q = page({ ...base, supervised: { running: false, pid: null, last: { at, line: 'supervise: gave up after 5 crashes in 10 min' } } }, null);
  await q.flush();
  assert.ok(text(q.ids.get('now-body')!).includes('not supervised'));
  const none = page(base, null);
  await none.flush();
  assert.ok(!text(none.ids.get('now-body')!).includes('supervis'), 'never supervised: no line');
});

test('Waiting on you: a card above the panels, before Now; dashboardState and /api/board carry the open needs-human list; the page renders it as text', E2E, async () => {
  const card = html.indexOf('<h2 class="h2">WAITING ON YOU</h2>');
  assert.ok(card >= 0 && card < html.indexOf('>NOW</h3>'), 'before Now');
  assert.ok(card > html.indexOf('</header>') && card < html.indexOf('aria-label="Board"'), 'between the header and the four panels');
  assert.ok(html.indexOf('id="waiting-body"') < html.indexOf('id="now-body"'));
  const { dashboardState } = await import('../src/dashboard.ts');
  const before = readFileSync(stateFile, 'utf8');
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
    { number: 12, title: XSS, body: 'q', state: 'OPEN', labels: [L.needsHuman] },
    { number: 5, title: 'Keep the old API?', body: 'q', state: 'OPEN', labels: [L.needsHuman, L.ready] },
    { number: 9, title: 'answered', body: 'q', state: 'CLOSED', labels: [L.needsHuman] },
    { number: 3, title: 'a task', body: 't', state: 'OPEN', labels: [L.ready] },
  ] }));
  try {
    const d = await serveDashboard(project as any, { port: 0 });
    servers.push(d);
    assert.equal(JSON.parse((await get(d.port, '/api/state')).body).waiting, null, 'null before any board read');
    const board = JSON.parse((await get(d.port, '/api/board')).body);
    const want = [{ number: 5, title: 'Keep the old API?', url: 'https://github.com/me/app/issues/5' },
      { number: 12, title: XSS, url: 'https://github.com/me/app/issues/12' }];
    assert.deepEqual(board.questions, want);
    const state = JSON.parse((await get(d.port, '/api/state')).body);
    assert.deepEqual(state.waiting, want, 'from the last board read; the closed one is not listed');
    assert.deepEqual((dashboardState(project as any, () => ({ plan: { questions: want } as any })) as any).waiting, want);
    assert.equal((dashboardState(project as any, () => ({})) as any).waiting, null);

    // rendered from /api/state alone (no board): text nodes and integer links only
    const p = page(state, null);
    await p.flush();
    const w = p.ids.get('waiting-body')!;
    assert.ok(text(w).includes('#5') && text(w).includes('Keep the old API?'), text(w));
    assert.ok(text(w).includes(XSS), 'the hostile title verbatim, as text');
    assert.ok(w.all().every((e) => e.tag !== 'img'));
    assert.deepEqual(links(w), ['https://github.com/me/app/issues/5', 'https://github.com/me/app/issues/12']);
    assert.ok(!text(w).includes('answered'));
    // before a board read: waiting for the board; an empty list: the note
    const p0 = page({ ...state, waiting: null }, null);
    await p0.flush();
    assert.equal(text(p0.ids.get('waiting-body')!), 'waiting for the board');
    const pe = page({ ...state, waiting: null }, { ...board, questions: [] });
    await pe.flush();
    assert.equal(text(pe.ids.get('waiting-body')!), 'nothing waiting on you', 'the board read fills it at once');
  } finally { writeFileSync(stateFile, before); }
});

test('a held issue renders as held (main red); /api/board carries held from .hx/held.json (#301)', E2E, async () => {
  const b = { at: new Date().toISOString(), repo: 'me/app', prds: [], board: [
    { number: 7, title: 'held one', status: 'claimable', waitingOn: [], held: true },
    { number: 9, title: 'plain', status: 'claimable', waitingOn: [] },
  ] };
  const p = page({ repo: 'me/app', runner: { running: false }, sessions: [], gate: null, health: null, log: [],
    usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } }, b);
  await p.flush();
  const rows = p.ids.get('board-body')!.all().filter((e) => e.tag === 'tr').map((r) => r.all().filter((c) => c.tag === 'td' || c.tag === 'th').map(text));
  assert.deepEqual(rows.slice(1).map((r) => r.slice(1)), [['held one', 'held (main red)'], ['plain', 'claimable']]);

  writeFileSync(path.join(stateDir, 'held.json'), JSON.stringify({ 7: { pr: 70, round: 1, at: new Date().toISOString() } }));
  try {
    const d = await serveDashboard(project as any, { port: 0 });
    servers.push(d);
    const board = JSON.parse((await get(d.port, '/api/board')).body);
    assert.equal(board.board.find((r: any) => r.number === 7)?.held, true);
  } finally { rmSync(path.join(stateDir, 'held.json'), { force: true }); }
});

test('Machine: the chart of CPU, free memory and workers, avg and p90 CPU, throughput rows with "not enough data", slowdown, role split, recommendation and its rule', E2E, async () => {
  assert.ok(html.indexOf('>MACHINE</h3>') > html.indexOf('>BOARD</h3>') && html.indexOf('>MACHINE</h3>') < html.indexOf('>STATS</h3>'));
  const base = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, usage: {}, outcomes: {}, log: [] };
  const from = '2026-11-05T12:00:00.000Z', to = '2026-11-06T12:00:00.000Z';
  const series = [0, 1, 2].map((k) => ({ ts: `2026-11-06T0${k + 1}:00:00.000Z`, cpuPct: 30 + 30 * k, freeMemGB: 8 - k, target: 2 + (k > 1 ? 1 : 0), running: k }));
  const machine = { from, to, days: 1, use: { series, avgCpu: 60.4, p90Cpu: 90 },
    throughput: [{ workers: 2, hours: 4, done: 8, perHour: 2, enough: true }, { workers: 3, hours: 2, done: 2, perHour: 1, enough: false }],
    slowdown: { baselineMs: 60_000, medianMs: 150_000, factor: 2.5, text: 'tests run 2.5× slower than at idle' },
    sessions: [{ role: XSS, sessions: 1, testShare: 0.1, otherShare: 0.9 }, { role: 'impl', sessions: 3, testShare: 0.5, otherShare: 0.5 }],
    recommendation: { rule: 'A', text: '3 workers get about as much done as 2 here; set `workers` to 2' } };
  const p = page({ ...base, machine }, null);
  await p.flush();
  const mb = p.ids.get('machine-body')!;
  const v = (k: string) => mb.all().find((e) => e.getAttribute('data-machine') === k)!;
  assert.equal(text(v('avgCpu')), '60%');
  assert.equal(text(v('p90Cpu')), '90%');

  const svg = v('chart');
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  const lines = svg.all().filter((e) => e.tag === 'polyline');
  assert.deepEqual(lines.map((l) => l.getAttribute('class')), ['cpu', 'mem', 'target', 'running']);
  const pts = (cls: string) => lines.find((l) => l.getAttribute('class') === cls)!.getAttribute('points')!.split(' ').map((s) => s.split(',').map(Number));
  for (const cls of ['cpu', 'mem', 'target', 'running']) assert.equal(pts(cls).length, 3, cls);
  assert.deepEqual(pts('cpu').map(([x]) => x), pts('target').map(([x]) => x), 'one time axis for use and workers');
  assert.ok(pts('cpu')[0][0] < pts('cpu')[2][0], 'later lines further right');
  assert.ok(pts('cpu')[0][1] > pts('cpu')[2][1], 'more CPU is higher');
  assert.ok(Math.max(...pts('cpu').map(([, y]) => y)) < Math.min(...pts('target').map(([, y]) => y)), 'workers in the band below');
  assert.ok(svg.all().filter((e) => e.tag === 'text').every((e) => e.viaTextContent), 'chart text set with textContent');

  const rows = mb.all().filter((e) => e.tag === 'tr').map((r) => r.all().filter((c) => c.tag === 'td' || c.tag === 'th').map(text));
  assert.deepEqual(rows.slice(0, 3), [['workers', 'hours', 'issues closed', 'per hour'], ['2', '4', '8', '2.00'], ['3', '2', '2', 'not enough data']]);
  assert.deepEqual(rows.slice(3), [['role', 'sessions', 'tests', 'other'], [XSS, '1', '10%', '90%'], ['impl', '3', '50%', '50%']]);
  assert.ok(mb.all().every((e) => e.tag !== 'img'), 'the role is text');
  assert.equal(text(v('slowdown')), 'tests run 2.5× slower than at idle');
  assert.ok(text(mb).includes('(median gate 2m 30s · idle 1m 00s)'), text(mb));
  assert.equal(text(v('recommendation')), '3 workers get about as much done as 2 here; set `workers` to 2');
  assert.match(text(v('rule')), /^\(rule A: /);
  for (const k of ['avgCpu', 'p90Cpu', 'slowdown', 'recommendation']) assert.ok(v(k).viaTextContent, `${k} is set with textContent`);

  // no history: no chart, notes instead; the fits rule names itself; an older payload without machine says so
  const empty = { from, to, days: 1, use: { series: [] }, throughput: [], slowdown: {}, sessions: [],
    recommendation: { rule: 'fits', text: 'the current setting fits this machine' } };
  const q = page({ ...base, machine: empty }, null);
  await q.flush();
  const qb = q.ids.get('machine-body')!;
  assert.ok(!qb.all().some((e) => e.tag === 'svg'));
  for (const w of ['CPU average -', 'p90 -', 'no load history in this period', 'not enough gate runs to compare', 'no test time in this period',
    'the current setting fits this machine (no other rule fired)']) assert.ok(text(qb).includes(w), w);
  const o = page(base, null);
  await o.flush();
  assert.equal(text(o.ids.get('machine-body')!), 'no machine data');
  assert.match(text(o.ids.get('stats-body')!), /Outcomes/, 'the rest still renders');
});

// ---- the control-room shell (#374): header strip, Waiting on you card, panels, More, raw log, tabs ----
const quiet = { repo: 'me/app', runner: { running: false }, sessions: [], gate: null, health: null, log: [], waiting: [], events: [],
  usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } };
const header = (p: ReturnType<typeof page>) => Object.fromEntries(['hd-runner', 'hd-machine', 'hd-main', 'hd-questions', 'hd-today']
  .map((id) => [id.slice(3), text(p.ids.get(id)!)]));
const dot = (p: ReturnType<typeof page>) => /background: (var\(--[\w-]+\))/.exec(p.ids.get('hd-runner-dot')!.getAttribute('style')!)?.[1];

test('header strip: RUNNER running / paused / stopped with its dot, MACHINE from workersLine, MAIN, WAITING ON YOU and TODAY', E2E, async () => {
  const run = { running: true, pid: 1, startedAt: new Date().toISOString(), uptimeMs: 0, workers: 3, paused: null, draining: false, pausedUntil: null,
    workersLine: 'workers 2/3 (auto: cpu 88%)' };
  const two = [{ number: 4, kind: 'impl', title: 'a', turn: 1, tokens: 0, since: run.startedAt, elapsedMs: 0 },
    { number: 0, kind: 'selfreview', title: '', turn: 1, tokens: 0, since: run.startedAt, elapsedMs: 0 }];
  const show = async (s: object, board: Payload = null) => { const p = page({ ...quiet, ...s }, board); await p.flush(); return p; };

  let p = await show({ runner: run, sessions: two, gate: { sha: 'abcdef1234567', ok: true, at: run.startedAt } });
  assert.deepEqual(header(p), { runner: 'running · 2/3 workers', machine: 'CPU 88% · auto-scale on', main: 'green ✓ abcdef1',
    questions: '0 questions', today: '0 PRDs closed' });
  assert.equal(dot(p), 'var(--blue)', 'blue while running');
  p = await show({ runner: { ...run, workersLine: 'workers 3/3 (auto: no reading yet)' }, sessions: [], gate: { sha: '1234567890', ok: false, at: run.startedAt } });
  assert.deepEqual([header(p).runner, header(p).machine, header(p).main], ['running · 0/3 workers', 'CPU – · auto-scale on', 'RED ✗ 1234567']);
  p = await show({ runner: { ...run, workersLine: null } });
  assert.equal(header(p).machine, 'auto-scale off');
  assert.equal(header(p).main, 'no run yet');

  for (const paused of [{ paused: 'now' }, { draining: true }, { pausedUntil: new Date(Date.now() + 3_600_000).toISOString() }]) {
    p = await show({ runner: { ...run, ...paused }, sessions: two });
    assert.equal(header(p).runner, 'paused · 2/3 workers', JSON.stringify(paused));
    assert.equal(dot(p), 'var(--grey)', 'grey while paused');
  }
  p = await show({ runner: { ...run, pausedUntil: new Date(Date.now() - 3_600_000).toISOString() } });
  assert.equal(header(p).runner, 'running · 0/3 workers', 'a pausedUntil in the past is no pause');

  p = await show({ runner: { running: false } });
  assert.deepEqual([header(p).runner, header(p).machine], ['stopped', '–']);
  assert.equal(dot(p), 'var(--grey)');

  // questions: – before the first board read, then the count from the state or the board read
  p = await show({ waiting: null });
  assert.equal(header(p).questions, '–');
  p = await show({ waiting: null }, { repo: 'me/app', prds: [], board: [], questions: [{ number: 5, title: 'q' }] });
  assert.equal(header(p).questions, '1 question');
  p = await show({ waiting: [{ number: 5, title: 'q' }, { number: 6, title: 'r' }] });
  assert.equal(header(p).questions, '2 questions');

  // today: the count of today's `PRD closed ✓` events
  const ev = (issue: number | null, step: string, text: string, kind = 'result') => ({ t: new Date().toISOString(), issue, step, text, tokens: null, kind });
  const events = [ev(8, 'Close', 'PRD closed ✓'), ev(7, 'Merge', 'DONE ✓ audited and merged'), ev(null, 'Gate', 'gate green ✓ at abc'), ev(9, 'Close', 'PRD closed ✓')];
  p = await show({ events });
  assert.equal(header(p).today, '2 PRDs closed');
  p = await show({ events: events.slice(0, 3) }, { repo: 'me/app', prds: [], board: [], questions: [] });
  assert.equal(header(p).today, '1 PRD closed');

  // under HX CONTROL ROOM: <repo> · <status>
  const under = p.ids.get('repo')!.parentNode as E;
  assert.match(text(under), /^me\/app · last updated \d\d:\d\d:\d\d$/);
  assert.ok(html.indexOf('<nav id="back"') < html.indexOf('<header'), '← all repos stays above the header');
});

test('Waiting on you card: hidden at 0 questions and before a board read, shown with questions, its list in #waiting-body', E2E, async () => {
  const card = (p: ReturnType<typeof page>) => p.ids.get('questions')!;
  assert.equal(card(page(quiet, null)).hidden, true, 'hidden in the markup');
  for (const waiting of [[], null]) {
    const p = page({ ...quiet, waiting }, null);
    await p.flush();
    assert.equal(card(p).hidden, true, JSON.stringify(waiting));
  }
  const p = page({ ...quiet, waiting: [{ number: 5, title: XSS }] }, null);
  await p.flush();
  assert.equal(card(p).hidden, false);
  assert.ok(p.ids.get('waiting-body')!.closest('#questions'), '#waiting-body is in the card');
  assert.ok(text(p.ids.get('waiting-body')!).includes(XSS));
  assert.ok(p.ids.get('waiting-body')!.all().every((e) => e.tag !== 'img'));
  // the board read shows it when the state has no list yet, and hides it again when the questions are answered
  let qs = [{ number: 5, title: 'q' }];
  const q = page({ ...quiet, waiting: null }, () => ({ repo: 'me/app', prds: [], board: [], questions: qs }));
  await q.flush();
  assert.equal(card(q).hidden, false);
  qs = [];
  q.tick();
  await q.flush();
  assert.equal(card(q).hidden, true);
  assert.equal(text(q.ids.get('hd-questions')!), '0 questions');
  assert.doesNotMatch(card(q).getAttribute('style')!, /display/, 'no inline display, so the hidden attribute hides it');
});

test('the four panels in the reference\'s order with their empty containers, then More; panels stack and scroll at phone width', E2E, async () => {
  const p = page(quiet, null);
  await p.flush();
  const sections = p.root.all().filter((e) => e.tag === 'section' && e.hasAttribute('aria-label')).map((e) => e.getAttribute('aria-label'));
  assert.deepEqual(sections, ['Waiting on you', 'Board', 'Pipeline', 'Issue details', 'Event log', 'More']);
  assert.ok(html.indexOf('</header>') < html.indexOf('aria-label="Board"'));
  for (const id of ['waiting', 'lanes', 'ticks']) assert.deepEqual(p.ids.get(id)!.childNodes, [], `#${id} is empty`);
  // the Flow's six columns are always there (#376): with no session each is idle and has no chip
  assert.equal(p.ids.get('stages')!.childNodes.length, 6);
  assert.equal(p.ids.get('stages')!.all().filter((e) => e.tag === 'button').length, 0, 'no chip');
  assert.deepEqual(p.ids.get('groups')!.childNodes.map(text), ['Nothing on the board yet.'], 'the Board with no group (#375)');
  assert.deepEqual(p.ids.get('details')!.childNodes.map(text), ['Nothing selected.'], 'Details with nothing selected (#375)');
  assert.deepEqual(p.ids.get('events')!.childNodes.map(text), ['No events today.'], 'the Event log with no events (#377)');
  const row = p.ids.get('groups')!.closest('section')!.parentNode as E;
  assert.equal(row.style.flexWrap, 'wrap', 'the panels stack');
  assert.equal((p.ids.get('stages')!.parentNode as E).style.overflowX, 'auto', 'the Flow columns scroll sideways in their own box');
  assert.equal((p.ids.get('events')!.closest('table')!.parentNode as E).style.overflowX, 'auto', 'the event table scrolls in its own box');
  for (const h of ['HX CONTROL ROOM', 'RUNNER', 'MACHINE', 'MAIN', 'WAITING ON YOU', 'TODAY', 'BOARD', 'PIPELINE', 'DETAILS', 'EVENT LOG', 'MORE', 'WAITING FOR ANOTHER ISSUE',
    'today, from .hx/run.log · the selected issue is highlighted', 'Each bar is one session. Click one to see its issue. The gate row is the full test suite on main.',
    'TIME', 'ISSUE', 'STEP', 'WHAT HAPPENED', 'TOKENS']) assert.ok(text(p.root).includes(h), h);
});

test('the panel row and the Event log are the reference\'s markup, each colour as its property, sample values left out', E2E, () => {
  const lp = props(lightRoot().body);
  const byHex = new Map([...lp].map(([k, v]) => [v.toUpperCase(), k]));
  const cut = (t: string) => t.slice(t.indexOf('<div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch">'), t.indexOf('</section>', t.indexOf('aria-label="Event log"')));
  const want = cut(reference).replace(/#[0-9A-Fa-f]{6}\b/g, (h) => `var(${byHex.get(h.toUpperCase())})`)
    .replace(/<span>tests run [^<]*<\/span>/, '<span id="tests-line" hidden></span>')
    .replace(/<div class="mono" (style="flex: 1; display: flex; justify-content: space-between[^"]*")>(?:<span>\d\d:\d\d<\/span>)+<\/div>/, '<div id="ticks" class="mono" $1></div>');
  const got = cut(html).replace(/\s*<details[\s\S]*<\/details>\n/, '\n');
  assert.equal(got, want);
});

test('More holds Now, Board, Machine and Stats whole, after the Event log; the raw log sits in a collapsed <details> under the event table', E2E, async () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const s = { ...quiet, runner: { running: true, pid: 42, startedAt: since, uptimeMs: 60_000, workers: 3, paused: null, draining: false,
      pausedUntil: new Date(Date.now() + 3_600_000).toISOString(), pauseReason: 'usage', workersLine: 'workers 2/3 (auto: cpu 88%)',
      rateLimit: { status: 'allowed_warning', utilization: 0.5, type: 'five_hour' },
      budget: { windows: [{ line: 'budget five_hour 40%' }] }, github: { line: 'github core 1200/5000' } },
    sessions: [{ number: 4, kind: 'impl', title: 'a task', turn: 2, tokens: 10, since, elapsedMs: 60_000 }],
    gate: { sha: 'abcdef1234567', ok: false, at: since, fixIssue: 14 }, health: { at: since, line: 'health: 3 ✓' },
    supervised: { running: true, pid: 7, last: { at: since, line: 'supervise: started hx run (pid 8)' } },
    autoStart: { enabled: true, text: 'on (logon task)', at: since },
    usage: { total: { tokens: 5, sessions: 1, durationMs: 0 }, byRole: [{ key: 'impl', tokens: 5, turns: 1, sessions: 1, durationMs: 0 }],
      byModel: [{ key: 'claude-opus-5-5', tokens: 5, turns: 1, sessions: 1, durationMs: 0 }], byDay: [{ key: '2026-11-07', tokens: 5 }],
      byPrd: [{ key: '8', tokens: 5, turns: 1, sessions: 1, durationMs: 0 }] },
    time: { last24h: { share: 0.5, testRunMedian: 1000, gateMedian: 2000, gateP90: 3000 }, days: { from: '2026-10-25', testRun: [], gate: [] } },
    outcomes: { audit: { pass: 1, fail: 0 } }, machine: { from: since, to: since, days: 1, use: { series: [], avgCpu: 10, p90Cpu: 20 }, throughput: [],
      slowdown: {}, sessions: [], recommendation: { rule: 'fits', text: 'the current setting fits this machine' } },
    log: ['2026-11-07T10:00:00.000Z [#4] impl: a task'] };
  const b = { at: since, repo: 'me/app', questions: [], prds: [{ number: 8, title: 'a PRD', status: 'building', open: 1, closed: 1, waitingOn: [] }],
    board: [{ number: 4, title: 'a task', status: 'working', waitingOn: [] }] };
  const p = page(s, b);
  await p.flush();
  const more = p.root.all().find((e) => e.getAttribute('aria-label') === 'More')!;
  assert.ok(more.matches('.panel'));
  assert.equal(text(more.all().find((e) => e.tag === 'h2')!), 'MORE');
  for (const id of ['now-body', 'board-body', 'machine-body', 'stats-body']) assert.equal(p.ids.get(id)!.closest('#more'), more, `#${id} is in More`);
  assert.deepEqual(more.all().filter((e) => e.tag === 'h3' && e.parentNode!.parentNode === more).map(text), ['NOW', 'BOARD', 'MACHINE', 'STATS']);
  assert.ok(html.indexOf('aria-label="More"') > html.indexOf('aria-label="Event log"'), 'under the four panels');
  const t = text(more);
  for (const w of [
    'pid 42', 'uptime', 'workers 3', 'workers 2/3 (auto: cpu 88%)', 'paused until', '(usage)', 'five_hour: allowed_warning 50%', // the runner line
    'budget five_hour 40%', 'github core 1200/5000', // the budget and GitHub lines
    'RED', 'abcdef1', 'health: 3 ✓', 'supervised', 'supervise: started hx run (pid 8)', 'autoStart', 'on (logon task)', // gate, health, supervise, autoStart
    'a task', 'impl', // the sessions table
    'PRDs', 'a PRD', '1/2 done', 'Issues', 'working', 'board fetched', // the PRD and issue tables
    'CPU average 10%', 'the current setting fits this machine', // the Machine panel
    'Tokens per day', 'Test time', 'last 24 h: tests 50%', 'Outcomes', '1 PASS', 'By PRD', 'By role', 'By model', 'claude-opus-5-5', // Stats
  ]) assert.ok(t.includes(w), w);
  assert.deepEqual(links(more).filter((h) => h!.endsWith('/14')), ['https://github.com/me/app/issues/14'], 'the gate fix issue link');
  assert.ok(more.all().some((e) => e.getAttribute('data-time') === 'share'), 'the time / tests line');

  const log = p.ids.get('log')!;
  const details = log.closest('details')!;
  assert.ok(details, 'the raw log is in a <details>');
  assert.equal(details.hasAttribute('open'), false, 'collapsed');
  assert.equal(details.closest('section')!.getAttribute('aria-label'), 'Event log');
  assert.ok(html.indexOf('<details') > html.indexOf('<tbody id="events">'), 'below the event table');
  assert.equal(text(log), '2026-11-07T10:00:00.000Z [#4] impl: a task');
});

test('tabs: one click handler sets state and aria-selected, Flow / Timeline toggle with style.display, the state survives each poll', E2E, async () => {
  // one item, #351, on no board row and not running: nothing is selected until the click
  const p = page({ ...quiet, issues: { groups: [], items: [{ number: 351, prd: null, title: 't', group: 'other', status: 'waiting', word: 'waiting', since: null, steps: [], facts: [], next: '' }] } }, null);
  await p.flush();
  const sel = (key: string) => ['all', 'building', 'done', 'flow', 'timeline', 'results', 'problems']
    .map((v) => p.button(key, v)).filter((b) => b).map((b) => [b!.getAttribute(`data-${key}`), b!.getAttribute('aria-selected')]);
  assert.deepEqual(sel('board'), [['all', 'true'], ['building', 'false'], ['done', 'false']]);
  assert.deepEqual(sel('view'), [['flow', 'true'], ['timeline', 'false']]);
  assert.deepEqual(sel('filter'), [['all', 'true'], ['results', 'false'], ['problems', 'false']]);
  assert.equal(p.ids.get('flow')!.style.display, 'flex');
  assert.equal(p.ids.get('timeline')!.style.display, 'none');
  assert.deepEqual({ ...p.evaluate('state') }, { sel: null, board: 'all', view: 'flow', filter: 'all' });

  p.click(p.button('board', 'building')!);
  p.click(p.button('view', 'timeline')!);
  p.click(p.button('filter', 'problems')!);
  // a click on something inside a button counts; a click outside every button changes nothing
  const inner = p.document.createElement('span');
  p.button('board', 'done')!.appendChild(inner);
  p.click(inner);
  p.click(p.ids.get('groups')!);
  const chip = p.document.createElement('button');
  chip.setAttribute('data-sel', '351');
  p.ids.get('lanes')!.appendChild(chip);
  p.click(chip);
  const after = () => {
    assert.deepEqual({ ...p.evaluate('state') }, { sel: '351', board: 'done', view: 'timeline', filter: 'problems' });
    assert.deepEqual(sel('board'), [['all', 'false'], ['building', 'false'], ['done', 'true']]);
    assert.deepEqual(sel('view'), [['flow', 'false'], ['timeline', 'true']]);
    assert.deepEqual(sel('filter'), [['all', 'false'], ['results', 'false'], ['problems', 'true']]);
    assert.equal(p.ids.get('flow')!.style.display, 'none');
    assert.equal(p.ids.get('timeline')!.style.display, 'flex');
  };
  after();
  assert.deepEqual(p.ids.get('lanes')!.childNodes, [], 'the click re-rendered the panels (stubs: empty)');
  p.ids.get('groups')!.appendChild(p.document.createElement('div'));
  p.tick();
  await p.flush();
  after();
  assert.deepEqual(p.ids.get('groups')!.childNodes.map(text), ['Nothing on the board yet.'], 'each api/state poll re-renders the panels');
  p.click(p.button('view', 'flow')!);
  assert.equal(p.ids.get('flow')!.style.display, 'flex');
  assert.equal(p.ids.get('timeline')!.style.display, 'none');
  assert.ok(p.fetched.filter((u) => u === 'api/state').length >= 2);
  assert.match(script, /setInterval\(pollState, 5000\)/);
  assert.match(script, /setInterval\(pollBoard, 30000\)/);
});

test('the reference\'s DOT, LABEL and LCOLOR tables are in the page script for the panels, every colour a custom property', E2E, () => {
  const p = page(quiet, null);
  const DOT = p.evaluate('DOT'), LABEL = p.evaluate('LABEL'), LCOLOR = p.evaluate('LCOLOR');
  assert.deepEqual(Object.keys(DOT), ['done', 'merging', 'working', 'waiting']);
  assert.deepEqual({ ...LABEL }, { done: 'done', merging: 'merging', working: 'implementing', waiting: 'waiting' });
  assert.deepEqual({ ...LCOLOR }, { done: 'var(--blue)', merging: 'var(--blue)', working: 'var(--orange-text)', waiting: 'var(--muted-2)' });
  assert.equal(p.evaluate("statusStyle('working')"), 'font-size:12px;font-weight:600;color:var(--orange-text)');
  // the light values are the reference's: DOT / LCOLOR read back through :root give its strings
  const lp = props(lightRoot().body);
  const hex = (s: string) => s.replace(/var\((--[\w-]+)\)/g, (_, k) => lp.get(k)!);
  for (const k of Object.keys(DOT)) assert.ok(reference.includes(`${k}: '${hex(DOT[k])}'`), k);
  assert.ok(reference.includes(`const LCOLOR = { done: '${hex(LCOLOR.done)}', merging: '${hex(LCOLOR.merging)}', working: '${hex(LCOLOR.working)}', waiting: '${hex(LCOLOR.waiting)}' };`));
});
