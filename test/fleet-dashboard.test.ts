// hx dashboard --fleet: /api/fleet over temp repos listed in a temp HX_HOME, the per-repo dashboards under
// /repo/<k>/, and the pure list and board-count functions behind them. Fake gh, no real board.
import { deadPid, E2E } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'UTC'; // tokensByDay groups by local day: pin it for the fixture days below
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-fdash-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;

const { serveDashboard, serveFleetDashboard, boardCounts } = await import('../src/dashboard.ts');
const { DEFAULT_FLEET_WORKERS, listRepos } = await import('../src/fleet.ts');
const { DEFAULTS } = await import('../src/config.ts');
const L = DEFAULTS.labels;

// every repo sees the same board: one ready issue, one working, one blocked, one PRD being built
writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
  { number: 1, title: 'ready', body: 'a', state: 'OPEN', labels: [L.ready] },
  { number: 2, title: 'busy', body: 'b', state: 'OPEN', labels: [L.ready, L.working] },
  { number: 3, title: 'stuck', body: 'c', state: 'OPEN', labels: [L.ready, L.blocked] },
  { number: 4, title: 'prd', body: 'p', state: 'OPEN', labels: [L.prd] },
  { number: 5, title: 'child', body: 'x\n\n## Parent\n#4\n', state: 'CLOSED', labels: [L.ready] },
] }));
const setBoard = (extra: object) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), ...extra }));

let n = 0;
/** A fresh HX_HOME for one test; returns its .hx dir. */
function home(): string {
  process.env.HX_HOME = mkdtempSync(path.join(tmp, 'home-'));
  const d = path.join(process.env.HX_HOME, '.hx');
  mkdirSync(d);
  return d;
}
/** A temp hx repo with config.repo = repo; returns its root. */
function repo(name: string, files: Record<string, string> = {}): string {
  const root = path.join(tmp, `r${n++}`);
  mkdirSync(path.join(root, '.hx'), { recursive: true });
  writeFileSync(path.join(root, '.hx', 'config.json'), JSON.stringify({ repo: name, defaultBranch: 'main' }));
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(root, '.hx', f), text);
  return root;
}
const writeFleet = (dir: string, fleet: unknown) => writeFileSync(path.join(dir, 'fleet.json'), typeof fleet === 'string' ? fleet : JSON.stringify(fleet));
const writeRepos = (dir: string, repos: unknown) => writeFileSync(path.join(dir, 'repos.json'), typeof repos === 'string' ? repos : JSON.stringify(repos));
const seen = (root: string, name: string) => ({ root, repo: name, lastSeen: '2026-10-01T00:00:00Z' });

const u = (tokens: number) => ({ input: tokens, cacheWrite: 0, cacheRead: 0, output: 0 });
const usage = (...recs: [string, number][]) => recs.map(([ts, t]) => JSON.stringify({ ts, issue: 1, role: 'impl', sessionId: 's', iteration: 1,
  model: 'claude-opus-5-5', ok: true, usage: u(t), costUsd: 0, durationMs: 1, numTurns: 1 })).join('\n') + '\n';
const since = new Date(Date.now() - 5000).toISOString();
const live = (pid: number, name: string) => JSON.stringify({ pid, startedAt: since, repo: name, workers: 3, draining: false,
  rateLimit: { status: 'allowed' }, sessions: [{ key: 'issue:2', number: 2, kind: 'impl', title: 'busy', since, turn: 1, tokens: 10 }] });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function get(port: number, urlPath: string, o: { host?: string; method?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}` }, agent: false },
      (res) => { let body = ''; res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body })); });
    req.on('error', reject).end();
  });
}
const fleetJson = async (port: number) => { const r = await get(port, '/api/fleet'); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); };

const servers: { close(): Promise<void> }[] = [];
const start = async () => { const d = await serveFleetDashboard({ port: 0 }); servers.push(d); return d; };
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });

/** /api/fleet until every non-missing repo has a board or a boardError (the reads it started have settled). */
async function settled(port: number): Promise<any> {
  for (let i = 0; ; i++) {
    const f = await fleetJson(port);
    if (f.repos.every((r: any) => r.missing || r.board || r.boardError)) return f;
    if (i > 200) assert.fail(`board reads never settled: ${JSON.stringify(f.repos)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('listRepos: fleet.json repos, then unseen repos.json repos, in file order; names from repos.json; current entries kept', E2E, () => {
  const a = path.resolve(tmp, 'a'), b = path.resolve(tmp, 'b'), c = path.resolve(tmp, 'c'), d = path.resolve(tmp, 'd');
  const list = listRepos([{ root: a }, { root: c }, { nope: 1 }, null], [seen(c + path.sep, 'me/c'), seen(b, 'me/b'), { root: 7 }, { root: a, repo: 5 }], []);
  assert.deepEqual(list, [{ root: a, repo: null }, { root: c, repo: 'me/c' }, { root: b, repo: 'me/b' }]);
  // later: a is gone from both files, d is new: nothing is removed or reordered, d is appended
  const again = listRepos([], [seen(d, 'me/d'), seen(b, 'me/b2')], list);
  assert.deepEqual(again, [...list, { root: d, repo: 'me/d' }]);
  if (process.platform === 'win32') assert.equal(listRepos([{ root: a.toUpperCase() }], [], list).length, 3, 'sameRoot: case-insensitive on Windows');
});

test('boardCounts: ready = claimable, working, blocked = blocked-label + waiting, prdsOpen = PRDs not done; triage and untrusted in none', E2E, () => {
  const rows = (statuses: string[]) => statuses.map((status, i) => ({ number: i + 1, title: '', status, waitingOn: [] }));
  const plan = {
    board: rows(['triage', 'claimable', 'claimable', 'working', 'blocked-label', 'waiting', 'waiting', 'untrusted']),
    prds: rows(['gauntlet', 'decompose', 'building', 'review', 'security', 'done', 'done', 'working', 'waiting', 'blocked-label', 'untrusted']),
  };
  assert.deepEqual(boardCounts(plan as any), { ready: 2, working: 1, blocked: 3, prdsOpen: 9 });
  assert.deepEqual(boardCounts({ board: [], prds: [] }), { ready: 0, working: 0, blocked: 0, prdsOpen: 0 });
});

test('/api/fleet: fleet.json and repos.json repos listed once each, a missing root, runner, sessions, gate, pause, tokens, slots and hold', E2E, async () => {
  const hx = home();
  const today = new Date().toISOString();
  const a = repo('me/a', {
    'live.json': live(process.pid, 'me/a'), pause: 'now\n',
    'gate.json': JSON.stringify({ command: 'npm test', last: { sha: 'abc1234', ok: false, command: 'npm test', output: 'boom', at: '2026-10-01T11:21:00Z' } }),
    'usage.jsonl': usage(['2026-10-01T10:00:00Z', 100], ['2026-10-02T10:00:00Z', 20], [today, 5]),
  });
  const c = repo('me/c', { 'live.json': live(deadPid(), 'me/c'), 'usage.jsonl': usage(['2026-10-01T12:00:00Z', 1000], [today, 7]) });
  const b = repo('me/b');
  const gone = path.join(tmp, 'gone');
  writeFleet(hx, { repos: [{ root: a }, { root: c }], workers: 3 });
  writeRepos(hx, { repos: [seen(c, 'me/c'), seen(b, 'me/b'), seen(gone, 'me/gone')] });
  const slots = path.join(hx, 'fleet', 'slots');
  mkdirSync(slots, { recursive: true });
  writeFileSync(path.join(slots, '0.json'), JSON.stringify({ pid: process.pid, repo: 'me/a', issue: 2 }));
  writeFileSync(path.join(slots, '1.json'), JSON.stringify({ pid: deadPid(), repo: 'me/c', issue: 9 }));
  const hold = { until: Date.now() + 3_600_000, reason: 'usage limit', repo: 'me/a' };
  writeFileSync(path.join(hx, 'fleet', 'hold.json'), JSON.stringify(hold));

  const d = await start();
  const f = await fleetJson(d.port);
  assert.ok(Math.abs(Date.parse(f.at) - Date.now()) < 60_000);
  assert.deepEqual(f.fleet.slotsInUse, 1);
  assert.equal(f.fleet.fleetWorkers, 3);
  assert.deepEqual(f.fleet.hold, hold);
  const day = today.slice(0, 10);
  assert.deepEqual(f.fleet.tokensByDay, [{ key: '2026-10-01', tokens: 1100 }, { key: '2026-10-02', tokens: 20 }, { key: day, tokens: 12 }]);

  assert.deepEqual(f.repos.map((r: any) => [r.k, r.root, r.repo, r.missing]),
    [[0, a, 'me/a', false], [1, c, 'me/c', false], [2, b, 'me/b', false], [3, gone, 'me/gone', true]]);
  const [ra, rc, rb, rm] = f.repos;
  assert.deepEqual(rm, { k: 3, root: gone, repo: 'me/gone', missing: true });

  assert.equal(ra.running, true);
  assert.equal(ra.pid, process.pid);
  assert.equal(ra.workers, 3);
  assert.deepEqual(ra.sessions, [{ issue: 2, role: 'impl', since }]);
  assert.equal(ra.paused, 'now');
  assert.deepEqual(ra.gate, { ok: false, sha: 'abc1234', at: '2026-10-01T11:21:00Z' });
  assert.deepEqual(ra.rateLimit, { status: 'allowed' });
  assert.deepEqual(ra.tokens, { today: 5, total: 125 });

  for (const r of [rc, rb]) {
    assert.equal(r.running, false);
    assert.equal(r.pid, null);
    assert.equal(r.workers, null);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.paused, null);
    assert.equal(r.gate, null);
    assert.equal(r.rateLimit, null);
  }
  assert.deepEqual(rc.tokens, { today: 7, total: 1007 });
  assert.deepEqual(rb.tokens, { today: 0, total: 0 });

  // the board reads /api/fleet started: counts from the fake board, never awaited by the request itself
  const s = await settled(d.port);
  for (const r of s.repos.slice(0, 3)) {
    assert.deepEqual(r.board, { ready: 1, working: 1, blocked: 1, prdsOpen: 1 }, r.repo);
    assert.equal('boardError' in r, false);
  }
});

test('/api/fleet answers 200 with unparsable repos.json or fleet.json; a root with an unparsable config is missing, the others keep their data', E2E, async () => {
  const hx = home();
  const a = repo('me/a', { 'usage.jsonl': usage(['2026-10-01T10:00:00Z', 9]) });
  const bad = repo('me/bad');
  writeFileSync(path.join(bad, '.hx', 'config.json'), '{ not json');
  writeFleet(hx, { repos: [{ root: bad }, { root: a }], workers: 4 });
  writeRepos(hx, '{ broken');
  const d = await start();
  let f = await fleetJson(d.port);
  assert.equal(f.fleet.fleetWorkers, 4);
  assert.deepEqual(f.repos.map((r: any) => [r.k, r.root, r.missing]), [[0, bad, true], [1, a, false]]);
  assert.deepEqual(Object.keys(f.repos[0]).sort(), ['k', 'missing', 'repo', 'root']);
  assert.deepEqual(f.repos[1].tokens, { today: 0, total: 9 });

  // now fleet.json is the broken one: the default cap, repos.json's repos appended, the list's entries kept
  const b = repo('me/b');
  writeFleet(hx, '{ broken');
  writeRepos(hx, { repos: [seen(b, 'me/b')] });
  f = await fleetJson(d.port);
  assert.equal(f.fleet.fleetWorkers, DEFAULT_FLEET_WORKERS);
  assert.deepEqual(f.repos.map((r: any) => [r.k, r.root, r.repo, r.missing]), [[0, bad, null, true], [1, a, 'me/a', false], [2, b, 'me/b', false]]);

  // a fresh server on these files, and on files with no repos array
  assert.equal((await fleetJson((await start()).port)).repos.length, 1);
  writeFleet(hx, { workers: 5 });
  writeRepos(hx, { repos: 'no' });
  f = await fleetJson((await start()).port);
  assert.deepEqual([f.fleet.fleetWorkers, f.repos], [5, []]);
});

test('a repo added to repos.json while the server runs appears with the next k; existing entries keep theirs', E2E, async () => {
  const hx = home();
  const a = repo('me/a'), b = repo('me/b'), c = repo('me/c');
  writeRepos(hx, { repos: [seen(a, 'me/a'), seen(b, 'me/b')] });
  const d = await start();
  assert.deepEqual((await fleetJson(d.port)).repos.map((r: any) => [r.k, r.root]), [[0, a], [1, b]]);
  // c is put first in the file and a is forgotten: a keeps k 0, c gets k 2
  writeRepos(hx, { repos: [seen(c, 'me/c'), seen(b, 'me/b')] });
  assert.deepEqual((await fleetJson(d.port)).repos.map((r: any) => [r.k, r.root, r.repo]), [[0, a, 'me/a'], [1, b, 'me/b'], [2, c, 'me/c']]);
  assert.equal((await get(d.port, '/repo/2/api/state')).status, 200);
});

test('a board read that fails for one repo gives it a boardError; the other repos have their counts', E2E, async () => {
  const hx = home();
  const a = repo('me/a'), bad = repo('me/broken'), b = repo('me/b');
  writeRepos(hx, { repos: [seen(a, 'me/a'), seen(bad, 'me/broken'), seen(b, 'me/b')] });
  setBoard({ listFails: 'me/broken' });
  try {
    const d = await start();
    const first = await fleetJson(d.port);
    for (const r of first.repos) assert.equal(r.board, null, 'no read has finished before the first answer');
    const f = await settled(d.port);
    assert.match(f.repos[1].boardError, /502/);
    assert.equal(f.repos[1].board, null);
    for (const r of [f.repos[0], f.repos[2]]) {
      assert.deepEqual(r.board, { ready: 1, working: 1, blocked: 1, prdsOpen: 1 });
      assert.equal('boardError' in r, false);
    }
    // /repo/<k>/api/board shares the cache: the error, not a new read
    assert.match(JSON.parse((await get(d.port, '/repo/1/api/board')).body).error, /502/);
  } finally { setBoard({ listFails: false }); }
});

test('/repo/<k>/ answers what a single-repo dashboard answers; anything else under /repo is 404', E2E, async () => {
  const hx = home();
  const a = repo('me/a', {
    'live.json': live(process.pid, 'me/a'), 'usage.jsonl': usage(['2026-10-01T10:00:00Z', 100]),
    'run.log': '2026-10-01T10:00:00.000Z [#1] impl: ready\n2026-10-01T10:30:00.000Z [#1] DONE ✓ audited and merged (1 round(s))\n',
    'gate.json': JSON.stringify({ last: { sha: 'abc', ok: true, command: 'npm test', output: '', at: '2026-10-01T11:00:00Z' } }),
  });
  const gone = path.join(tmp, 'gone2');
  writeRepos(hx, { repos: [seen(a, 'me/a'), seen(gone, 'me/gone')] });
  const fleet = await start();
  const single = await serveDashboard({ root: a, stateDir: path.join(a, '.hx'), config: { ...DEFAULTS, repo: 'me/a', defaultBranch: 'main' } } as any, { port: 0 });
  servers.push(single);

  const page = await get(fleet.port, '/repo/0/'), own = await get(single.port, '/');
  assert.equal(page.status, 200);
  assert.equal(page.body, own.body);
  assert.equal(page.headers['content-security-policy'], own.headers['content-security-policy']);
  assert.equal(page.headers['content-type'], own.headers['content-type']);

  const strip = (body: string) => {
    const s = JSON.parse(body);
    delete s.runner.uptimeMs;
    for (const x of s.sessions) delete x.elapsedMs;
    delete s.machine.from; delete s.machine.to; // the Machine period ends at the request's now
    delete s.timeline.from; delete s.timeline.to; // so does the Timeline window, and a running bar
    for (const l of s.timeline.lanes) for (const b of l.bars) if (b.running) delete b.endMs;
    return s;
  };
  const before = strip((await get(fleet.port, '/repo/0/api/state')).body);
  assert.deepEqual(before, strip((await get(single.port, '/api/state')).body));
  assert.equal(before.usage.byPrd, null);
  const board = JSON.parse((await get(fleet.port, '/repo/0/api/board')).body), ownBoard = JSON.parse((await get(single.port, '/api/board')).body);
  assert.deepEqual({ ...board, at: 0 }, { ...ownBoard, at: 0 });
  assert.deepEqual(strip((await get(fleet.port, '/repo/0/api/state')).body), strip((await get(single.port, '/api/state')).body));

  for (const p of ['/repo/9/', '/repo/x/', '/repo/../', '/repo/0', '/repo/1/', '/repo/1/api/state', '/repo/0/api/nope', '/repo/0/x',
    '/repo/-1/', '/repo/0.0/', '/repo//', '/repo/', '/nope', '/api/state']) {
    assert.equal((await get(fleet.port, p)).status, 404, p);
  }
});

test('403 on a foreign Host and 405 on POST on every fleet route; / is the fleet page with the CSP', E2E, async () => {
  const hx = home();
  writeRepos(hx, { repos: [seen(repo('me/a'), 'me/a')] });
  const d = await start();
  for (const p of ['/', '/api/fleet', '/repo/0/', '/repo/0/api/state', '/repo/0/api/board']) {
    const foreign = await get(d.port, p, { host: `evil.example:${d.port}` });
    assert.equal(foreign.status, 403, p);
    const post = await get(d.port, p, { method: 'POST' });
    assert.equal(post.status, 405, p);
    assert.equal(post.headers.allow, 'GET', p);
    assert.equal((await get(d.port, p, { host: `localhost:${d.port}` })).status, 200, p);
  }
  const page = await get(d.port, '/');
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.equal(page.headers['content-security-policy'], // the overview loads no fonts: its policy is unchanged
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
  assert.equal((await get(d.port, '/repo/0/')).headers['content-security-policy'], // a repo's page under /repo/<k>/: the repo page's policy
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src https://fonts.gstatic.com");
  assert.equal(page.body, readFileSync(path.join(here, '..', 'src', 'dashboard-fleet.html'), 'utf8'));
  assert.equal(d.address().address, '127.0.0.1');
});

test('dashboard-fleet.html: no innerHTML, fetches only relative api/ paths, links repos with their k', E2E, () => {
  const html = readFileSync(path.join(here, '..', 'src', 'dashboard-fleet.html'), 'utf8');
  for (const w of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!html.includes(w), w);
  const fetches = [...html.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(fetches.length > 0);
  for (const f of fetches) assert.match(f, /^'api\/[a-z]+'$/, f);
  assert.match(html, /'repo\/' \+ r\.k \+ '\/'/);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
});

test('hx dashboard --fleet and hx fleet dashboard run outside any repo', E2E, async () => {
  const hx = home();
  writeRepos(hx, { repos: [seen(repo('me/a'), 'me/a')] });
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'hx-norepo-'));
  for (const args of [['dashboard', '--fleet', '--port', '0'], ['fleet', 'dashboard', '--port', '0']]) {
    const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd, env: process.env, windowsHide: true });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '', err = '';
        child.stdout.setEncoding('utf8').on('data', (s) => { out += s; const m = /on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) resolve(m[1]); });
        child.stderr.setEncoding('utf8').on('data', (s) => (err += s));
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}${err}`)));
      });
      const f = await fleetJson(Number(new URL(url).port));
      assert.deepEqual(f.repos.map((r: any) => r.repo), ['me/a'], args.join(' '));
    } finally { child.kill(); }
  }
});
