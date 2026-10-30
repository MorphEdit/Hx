// hx dashboard: the localhost-only read-only server over .hx/ fixture files and a fake gh board.
import { deadPid, E2E } from './isolate.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dash-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_GH_LOG = ghLog;

const { serveDashboard, tailLines } = await import('../src/dashboard.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { parseOutcomes } = await import('../src/outcomes.ts');
const { plan } = await import('../src/state.ts');

const L = DEFAULTS.labels;
const stateDir = path.join(tmp, '.hx');
mkdirSync(stateDir);
const project = { root: tmp, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } };

// PRD #10 (closed) has children #11 and #12; #13 has no parent
const issues = [
  { number: 10, title: 'feature', body: 'the PRD', state: 'CLOSED', labels: [L.prd] },
  { number: 11, title: 'part a', body: 'a\n\n## Parent\n#10\n', state: 'CLOSED', labels: [L.ready] },
  { number: 12, title: 'part b', body: 'b\n\n## Parent\n#10\n', state: 'OPEN', labels: [L.ready] },
  { number: 13, title: 'loose', body: 'c', state: 'OPEN', labels: [L.ready] },
];
const board = (extra = {}) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues, ...extra }));
board();

const u = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const rec = (issue: number, role: string, ts: string, tokens: number, durationMs: number, sessionId = `s${issue}${role}`) =>
  ({ ts, issue, role, sessionId, iteration: 1, model: 'claude-opus-5-5', ok: true, usage: u(tokens, 0), costUsd: 0, durationMs, numTurns: 1 });
writeFileSync(path.join(stateDir, 'usage.jsonl'), [
  rec(11, 'impl', '2026-10-01T10:00:00Z', 100, 1000),
  rec(12, 'impl', '2026-10-01T11:00:00Z', 200, 2000),
  rec(12, 'audit', '2026-10-02T09:00:00Z', 50, 500),
  rec(13, 'impl', '2026-10-02T10:00:00Z', 7, 70),
].map((r) => JSON.stringify(r)).join('\n') + '\n');

const oldLog = [
  '2026-10-01T10:00:00.000Z #11 impl: part a',
  '2026-10-01T10:30:00.000Z #11 audit PASS ✓',
];
const newLog = [
  '2026-10-01T10:31:00.000Z #11 DONE ✓ audited and merged (1 round(s))',
  '2026-10-01T11:00:00.000Z #12 impl: part b',
  '2026-10-01T11:20:00.000Z #12 audit FAIL ✗ missing test',
  '2026-10-01T11:21:00.000Z - gate RED ✗ at abc1234',
  '2026-10-01T11:31:00.000Z - gate green ✓ again at def5678',
];
writeFileSync(path.join(stateDir, 'run.log.1'), oldLog.join('\n') + '\n');
writeFileSync(path.join(stateDir, 'run.log'), newLog.join('\n') + '\n');
writeFileSync(path.join(stateDir, 'gate.json'), JSON.stringify({ command: 'npm test', fixIssue: 14,
  last: { sha: 'abc1234', ok: false, command: 'npm test', output: 'boom', at: '2026-10-01T11:21:00Z' } }));

const since = new Date(Date.now() - 5000).toISOString();
const live = (pid: number) => writeFileSync(path.join(stateDir, 'live.json'), JSON.stringify({ pid, startedAt: since, repo: 'me/app', workers: 2,
  draining: false, sessions: [{ key: 'issue:12', number: 12, kind: 'impl', title: 'part b', since, turn: 2, tokens: 1234 }] }));
const noLive = () => rmSync(path.join(stateDir, 'live.json'), { force: true });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function get(port: number, urlPath: string, o: { host?: string; method?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}` }, agent: false },
      (res) => { let body = ''; res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body })); });
    req.on('error', reject).end();
  });
}
const listCalls = () => { try { return readFileSync(ghLog, 'utf8').split('\n').filter((l) => l.startsWith('issue list')).length; } catch { return 0; } };

const servers: { close(): Promise<void> }[] = [];
const start = async (o = {}) => { const d = await serveDashboard(project as any, { port: 0, ...o }); servers.push(d); return d; };
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });

test('binds 127.0.0.1 only and builds its URL from the bound port', E2E, async () => {
  const d = await start();
  assert.equal(d.address().address, '127.0.0.1');
  assert.equal(d.url, `http://127.0.0.1:${d.port}/`);
});

test('/api/state: runner, sessions, gate, usage by role and by PRD, log, outcomes from the fixtures', E2E, async () => {
  board();
  live(process.pid);
  const d = await start();
  const r = await get(d.port, '/api/state');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^application\/json/);
  const s = JSON.parse(r.body);
  assert.equal(s.repo, 'me/app');
  assert.equal(s.runner.running, true);
  assert.equal(s.runner.pid, process.pid);
  assert.equal(s.runner.workers, 2);
  assert.equal(s.runner.paused, null);
  assert.equal(s.runner.draining, false);
  assert.ok(s.runner.uptimeMs >= 4000);
  assert.equal(s.sessions.length, 1);
  assert.deepEqual({ ...s.sessions[0], elapsedMs: undefined }, { number: 12, kind: 'impl', title: 'part b', turn: 2, tokens: 1234, since, elapsedMs: undefined });
  assert.ok(s.sessions[0].elapsedMs >= 4000);
  assert.deepEqual(s.gate, { sha: 'abc1234', ok: false, at: '2026-10-01T11:21:00Z', command: 'npm test', fixIssue: 14 });

  const row = (rows: any[], k: string) => rows.find((x) => x.key === k);
  assert.equal(s.usage.total.tokens, 357);
  assert.equal(s.usage.total.durationMs, 3570);
  assert.equal(row(s.usage.byRole, 'impl').tokens, 307);
  assert.equal(row(s.usage.byRole, 'impl').durationMs, 3070);
  assert.equal(row(s.usage.byRole, 'audit').tokens, 50);
  assert.equal(s.usage.byPrdSource, 'board');
  assert.equal(s.usage.boardError, undefined);
  assert.equal(row(s.usage.byPrd, '10').tokens, 350, 'children #11 and #12 are summed under their closed PRD #10');
  assert.equal(row(s.usage.byPrd, '10').durationMs, 3500);
  assert.equal(row(s.usage.byPrd, '10').sessions, 3);
  assert.equal(row(s.usage.byPrd, '13').tokens, 7);
  assert.equal(s.usage.byPrd.length, 2);
  assert.deepEqual(s.usage.byDay.map((x: any) => [x.key, x.tokens]), [['2026-10-01', 300], ['2026-10-02', 57]]);
  assert.equal(row(s.usage.byModel, 'claude-opus-5-5').tokens, 357);

  assert.deepEqual(s.log, newLog);
  assert.deepEqual(s.outcomes, parseOutcomes([...oldLog, ...newLog].join('\n')));
  assert.equal(s.outcomes.audit.pass, 1);
  assert.equal(s.outcomes.audit.fail, 1);
  assert.equal(s.outcomes.audit.mergedIssues, 1);
  assert.equal(s.outcomes.issues.done, 1);
  assert.equal(s.outcomes.issues.medianMs, 31 * 60_000, 'the impl line in run.log.1 starts #11');
  assert.equal(s.outcomes.gate.recovered, 1);
});

test('a live.json with a dead pid reads as not running, with no sessions', E2E, async () => {
  live(deadPid());
  const d = await start();
  const s = JSON.parse((await get(d.port, '/api/state')).body);
  assert.deepEqual(s.runner, { running: false });
  assert.deepEqual(s.sessions, []);
});

test('no live.json: / serves the page with its CSP and /api/state says not running', E2E, async () => {
  noLive();
  const d = await start();
  const page = await get(d.port, '/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.equal(page.headers['content-security-policy'],
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
  assert.equal(page.body, readFileSync(path.join(here, '..', 'src', 'dashboard.html'), 'utf8'));
  const r = await get(d.port, '/api/state', { host: `localhost:${d.port}` });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).runner.running, false);
});

test('a foreign Host gets 403, a POST 405 with Allow: GET, an unknown path 404; never CORS, always nosniff', E2E, async () => {
  const d = await start();
  const rs = [
    await get(d.port, '/api/state', { host: 'evil.example' }),
    await get(d.port, '/', { host: `evil.example:${d.port}` }),
    await get(d.port, '/', { host: `127.0.0.1:${d.port + 1}` }),
    await get(d.port, '/api/state', { method: 'POST' }),
    await get(d.port, '/nope'),
    await get(d.port, '/'),
    await get(d.port, '/api/state'),
    await get(d.port, '/api/board'),
  ];
  assert.deepEqual(rs.map((r) => r.status), [403, 403, 403, 405, 404, 200, 200, 200]);
  assert.equal(rs[3].headers.allow, 'GET');
  for (const r of rs) {
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['content-type']);
  }
});

test('/api/board: one gh issue list per 30 s, shared by concurrent requests and by /api/state', E2E, async () => {
  board();
  const d = await start();
  const before = listCalls();
  const [a, b] = await Promise.all([get(d.port, '/api/board'), get(d.port, '/api/board')]);
  await get(d.port, '/api/board');
  await get(d.port, '/api/state');
  assert.equal(listCalls() - before, 1);
  const j = JSON.parse(a.body);
  assert.equal(a.status, 200);
  assert.deepEqual(JSON.parse(b.body), j);
  assert.equal(j.repo, 'me/app');
  assert.equal(j.error, undefined);
  assert.ok(!Number.isNaN(Date.parse(j.at)));
  assert.deepEqual(j.board.map((r: any) => r.number).sort(), [12, 13]);
  assert.ok(Array.isArray(j.prds));
});

test('gh failing: /api/board returns { error } (cached too), /api/state still 200 with usage by issue', E2E, async () => {
  board({ listFails: true });
  try {
    const d = await start();
    const before = listCalls();
    const r = await get(d.port, '/api/board');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.match(j.error, /Bad Gateway/);
    assert.deepEqual(j.board, []);
    const st = await get(d.port, '/api/state');
    assert.equal(st.status, 200);
    const s = JSON.parse(st.body);
    assert.equal(s.usage.byPrdSource, 'issues');
    assert.match(s.usage.boardError, /Bad Gateway/);
    assert.deepEqual(s.usage.byPrd.map((x: any) => x.key).sort(), ['11', '12', '13']);
    assert.equal(listCalls() - before, 1, 'the error is cached for the TTL as well');
  } finally { board(); }
});

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
});
const occupy = (port: number) => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(port, '127.0.0.1', () => resolve(s));
});

test('close() resolves and frees the port, even with a keep-alive connection open', E2E, async () => {
  const d = await serveDashboard(project as any, { port: 0 });
  await get(d.port, '/');
  await d.close();
  const s = await occupy(d.port);
  await new Promise((r) => s.close(r));
});

test('a port in use: the next one is tried', E2E, async () => {
  const port = await freePort();
  const busy = await occupy(port);
  try {
    const d = await start({ port });
    assert.ok(d.port > port && d.port <= port + 9, String(d.port));
  } finally { await new Promise((r) => busy.close(r)); }
});

test('tailLines reads the last n lines of a file larger than one read chunk', E2E, () => {
  const f = path.join(tmp, 'big.log');
  writeFileSync(f, Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'é'.repeat(10)}`).join('\n') + '\n');
  const t = tailLines(f, 200);
  assert.equal(t.length, 200);
  assert.equal(t[0], `line 19800 ${'é'.repeat(10)}`);
  assert.equal(t[199], `line 19999 ${'é'.repeat(10)}`);
  assert.deepEqual(tailLines(path.join(tmp, 'missing.log'), 5), []);
  writeFileSync(f, 'a\nb');
  assert.deepEqual(tailLines(f, 200), ['a', 'b']);
});

test('plan().parents maps each child to its PRD, closed PRDs included', E2E, () => {
  const pl = plan(issues.map((i) => ({ ...i, author: 'me' })) as any, 'me/app', L, new Map(), new Set(), { trusted: new Set(['me']) });
  assert.deepEqual(pl.parents, { 11: 10, 12: 10 });
});

test('hx help lists hx dashboard with its flags and default URL', E2E, async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dashboard \[--port N\] \[--open\]/);
  assert.ok(r.stdout.includes('http://127.0.0.1:4777/'));
});
