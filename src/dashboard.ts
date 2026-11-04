// hx dashboard: a read-only page over .hx/ (live.json, usage.jsonl, gate.json, run.log.1 + run.log) and the board.
// Localhost only: it binds 127.0.0.1, answers only a Host of 127.0.0.1:<port> or localhost:<port> (so a
// web page cannot reach it through DNS rebinding), takes GET only and sends no CORS headers.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetLine } from './budget.ts';
import { loadProject, type Project, STATE_DIR } from './config.ts';
import { DEFAULT_FLEET_WORKERS, type Fleet, fleetDir, fleetWorkers, type ListedRepo, listRepos, readFleet, readHold, readRepos, slotsInUse } from './fleet.ts';
import { githubLine } from './ghlimit.ts';
import { type GateRun, readGate, readGateRuns } from './gate.ts';
import { parseOutcomes } from './outcomes.ts';
import { lookupTrusted, readPlan, runLogFile } from './pool.ts';
import { pidAlive, readLive, readPause } from './runstate.ts';
import type { Plan } from './state.ts';
import { testSeries, timeWindow } from './timing.ts';
import { localDay, readUsage, summarize, totalTokens, type UsageRecord, type UsageRow } from './usage.ts';

export const HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
export const FLEET_HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard-fleet.html');
export const DEFAULT_PORT = 4777;
export const BOARD_TTL_MS = 30_000;
const HOST = '127.0.0.1';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";
const LOG_LINES = 200;

interface BoardEntry { at: number; plan?: Plan; error?: string }

/** What /api/state knows of the board without fetching it: the last successful plan and the latest error. */
export interface BoardSeen { plan?: Plan; error?: string }

/** The board, fetched at most once per ttl; concurrent callers share one fetch; a failure is cached too.
 *  `seen()` never fetches: the last successful plan (kept across later failures) and the latest error. */
export interface BoardCache { fetch(): Promise<BoardEntry>; seen(): BoardSeen }
export function boardCache(p: Project, ttl = BOARD_TTL_MS): BoardCache {
  let entry: BoardEntry | null = null;
  let lastPlan: Plan | undefined;
  let inFlight: Promise<BoardEntry> | null = null;
  return {
    fetch: () => {
      if (entry && Date.now() - entry.at < ttl) return Promise.resolve(entry);
      return inFlight ??= (async () => {
        try { entry = { at: Date.now(), plan: lastPlan = await readPlan(p, await lookupTrusted(p.config)) }; }
        catch (e: any) { entry = { at: Date.now(), error: String(e?.message ?? e) }; }
        inFlight = null;
        return entry;
      })();
    },
    seen: () => ({ plan: lastPlan, error: entry?.error }),
  };
}

/** The last `n` lines of a file, reading only its tail. */
export function tailLines(file: string, n: number): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    let pos = size, text = '';
    const chunk = Buffer.alloc(64 * 1024);
    // n + 1 newlines: the first line in the buffer may be cut off
    while (pos > 0 && (text.match(/\n/g)?.length ?? 0) <= n) {
      const len = Math.min(chunk.length, pos);
      pos -= len;
      readSync(fd, chunk, 0, len, pos);
      text = chunk.toString('latin1', 0, len) + text;
    }
    const lines = Buffer.from(text, 'latin1').toString('utf8').split(/\r?\n/);
    if (pos > 0) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n);
  } finally { closeSync(fd); }
}

type Row = UsageRow & { tokens: number; durationMs: number };

function rows(recs: UsageRecord[], keyOf: (r: UsageRecord) => string): Row[] {
  const dur = new Map<string, number>();
  for (const r of recs) dur.set(keyOf(r), (dur.get(keyOf(r)) ?? 0) + (r.durationMs ?? 0));
  return summarize(recs, keyOf).map((r) => ({ ...r, tokens: totalTokens(r.usage), durationMs: dur.get(r.key) ?? 0 }));
}

const DAY_MS = 86_400_000;
export const TIME_DAYS = 14;

/** Stats' test time: the hx status numbers over the last 24 h, and per UTC day of the last 14 (today included)
 *  the median test-run and gate duration. A missing value is null; a day with no value for a series has no point in it. */
export function testTime(recs: UsageRecord[], gates: GateRun[], now = Date.now()) {
  const w = timeWindow(recs, gates, now - DAY_MS, Infinity);
  const from = Math.floor(now / DAY_MS) * DAY_MS - (TIME_DAYS - 1) * DAY_MS;
  const inRange = (r: { ts: string }) => Date.parse(r.ts) >= from;
  const days = testSeries(recs.filter(inRange), gates.filter(inRange));
  const points = (k: 'testRunMedian' | 'gateMedian') => days.filter((d) => d[k] !== undefined).map((d) => ({ day: d.day, ms: d[k]! }));
  return {
    last24h: { share: w.share ?? null, testRunMedian: w.testRunMedian ?? null, gateMedian: w.gateMedian ?? null, gateP90: w.gateP90 ?? null },
    days: { from: new Date(from).toISOString().slice(0, 10), testRun: points('testRunMedian'), gate: points('gateMedian') },
  };
}

/** Reads .hx/ only and never calls gh: usage by PRD comes from the last board /api/board fetched, null before one. */
export function dashboardState(p: Project, board: () => BoardSeen): object {
  const dir = p.stateDir, now = Date.now();
  const live = readLive(dir);
  const running = !!live && pidAlive(live.pid);
  const runner = running ? {
    running: true, pid: live.pid, startedAt: live.startedAt, uptimeMs: now - Date.parse(live.startedAt), workers: live.workers,
    paused: readPause(dir), draining: !!live.draining, pausedUntil: live.pausedUntil ?? null, pauseReason: live.pauseReason ?? null,
    rateLimit: live.rateLimit ?? null,
    // like rateLimit, only from a live runner; each window carries the line hx status prints
    budget: live.budget ? { windows: live.budget.windows.map((w) => ({ ...w, line: budgetLine(w, p.config.budgetMinPairs) })) } : null,
    github: live.github ? { ...live.github, line: githubLine(live.github) } : null, // the GitHub API budget, with the hx status line
  } : { running: false };
  const sessions = running ? live.sessions.map((s) => ({ number: s.number, kind: s.kind, title: s.title, turn: s.turn, tokens: s.tokens,
    since: s.since, elapsedMs: now - Date.parse(s.since) })) : [];
  const g = readGate(dir);
  const gate = g.last ? { sha: g.last.sha, ok: g.last.ok, at: g.last.at, command: g.last.command, fixIssue: g.fixIssue ?? null } : null;

  const recs = readUsage(dir);
  const b = board();
  const parents = b.plan?.parents;
  const usage = {
    total: rows(recs, () => 'total')[0] ?? null,
    byRole: rows(recs, (r) => r.role ?? 'impl'),
    byModel: rows(recs, (r) => r.actualModel ?? r.model), // the model that ran, when the CLI reported it
    byDay: rows(recs, (r) => localDay(r.ts)),
    byPrd: parents ? rows(recs, (r) => String(parents[r.issue] ?? r.issue)) : null,
    ...(b.error !== undefined ? { boardError: b.error } : {}),
  };

  const logFile = runLogFile(dir);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  // run.log.1 (the one rotated file, when there is one) then run.log, as one line sequence
  const outcomes = parseOutcomes([...read(`${logFile}.1`).split(/\r?\n/), ...read(logFile).split(/\r?\n/)]);
  return { repo: p.config.repo, runner, sessions, gate, usage, time: testTime(recs, readGateRuns(dir), now), log: tailLines(logFile, LOG_LINES), outcomes };
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const TEXT = 'text/plain; charset=utf-8';
const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve((server.address() as { port: number }).port); };
    server.once('error', onError).once('listening', onListening);
    server.listen(port, HOST);
  });
}

export interface DashboardServer { url: string; port: number; address(): AddressInfo; close(): Promise<void> }

/** `/`, `/api/state` and `/api/board` of one repo's dashboard; false when route is none of them. */
async function repoRoute(p: Project, board: BoardCache, html: string, route: string, res: ServerResponse): Promise<boolean> {
  if (route === '/') { send(res, 200, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': CSP }); return true; }
  if (route === '/api/state') { json(res, 200, dashboardState(p, board.seen)); return true; }
  if (route === '/api/board') {
    const b = await board.fetch();
    json(res, 200, { at: new Date(b.at).toISOString(), repo: p.config.repo, prds: b.plan?.prds ?? [], board: b.plan?.board ?? [],
      ...(b.error !== undefined ? { error: b.error } : {}) });
    return true;
  }
  return false;
}

/** The server both dashboards run on: 127.0.0.1 only, the Host check, GET only, opts.port (default 4777) or the next free one. */
async function serve(handle: (route: string, res: ServerResponse) => Promise<void>, opts: { port?: number; open?: boolean }): Promise<DashboardServer> {
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return send(res, 403, TEXT, 'forbidden host\n');
    if (req.method !== 'GET') return send(res, 405, TEXT, 'method not allowed\n', { Allow: 'GET' });
    handle((req.url ?? '/').split('?')[0], res)
      .catch((e) => { if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) }); else res.end(); });
  });

  const first = opts.port ?? DEFAULT_PORT;
  const last = first === 0 ? 0 : first + 9;
  for (let at = first; ; at++) {
    try { port = await listen(server, at); break; } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if (at >= last) throw new Error(first === last ? `port ${first} is in use` : `ports ${first}-${last} are all in use: pick another with --port`);
    }
  }
  const url = `http://${HOST}:${port}/`;
  if (opts.open) openBrowser(url);
  return {
    url, port,
    address: () => server.address() as AddressInfo,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
      server.closeAllConnections();
    }),
  };
}

export async function serveDashboard(p: Project, opts: { port?: number; open?: boolean } = {}): Promise<DashboardServer> {
  const html = readFileSync(HTML_FILE, 'utf8');
  const board = boardCache(p);
  return serve(async (route, res) => { if (!(await repoRoute(p, board, html, route, res))) send(res, 404, TEXT, 'not found\n'); }, opts);
}

// hx dashboard --fleet: /api/fleet over every known repo, each repo's dashboard under /repo/<k>/, the overview at /.

export interface BoardCounts { ready: number; working: number; blocked: number; prdsOpen: number }

/** A repo's board summary on the fleet page; triage and untrusted rows are in no count. */
export function boardCounts(plan: Pick<Plan, 'board' | 'prds'>): BoardCounts {
  const n = (s: string) => plan.board.filter((r) => r.status === s).length;
  return { ready: n('claimable'), working: n('working'), blocked: n('blocked-label') + n('waiting'),
    prdsOpen: plan.prds.filter((r) => r.status !== 'done').length };
}

/** The repo at root, or null when it is missing: no .hx/config.json at root itself, or loadProject throws. */
function projectAt(root: string): Project | null {
  if (!existsSync(path.join(root, STATE_DIR, 'config.json'))) return null;
  try { return loadProject(root); } catch { return null; }
}

/** fleet.json and its cap; no repos and the default cap when it cannot be used. */
function fleetOrEmpty(): { fleet: Fleet; workers: number } {
  try {
    const fleet = readFleet();
    const w = fleetWorkers(fleet);
    return { fleet, workers: Number.isInteger(w) && w > 0 ? w : DEFAULT_FLEET_WORKERS };
  } catch { return { fleet: { repos: [] }, workers: DEFAULT_FLEET_WORKERS }; }
}

/** One repo's /api/fleet entry (missing on any error). Its usage days are added to byDay only once the entry is built. */
function fleetEntry(k: number, e: ListedRepo, board: (p: Project) => BoardCache, byDay: Map<string, number>, today: string): object {
  const missing = { k, root: e.root, repo: e.repo, missing: true };
  try {
    const p = projectAt(e.root);
    if (!p) return missing;
    const dir = p.stateDir;
    const live = readLive(dir);
    const running = !!live && pidAlive(live.pid);
    const g = readGate(dir).last;
    const days = new Map<string, number>();
    let total = 0, todayTokens = 0;
    for (const r of readUsage(dir)) { // one pass feeds this repo's tokens and the fleet's tokens by day
      if (!r?.usage) continue;
      const t = totalTokens(r.usage), day = localDay(r.ts);
      total += t;
      if (day === today) todayTokens += t;
      days.set(day, (days.get(day) ?? 0) + t);
    }
    const cache = board(p);
    const seen = cache.seen();
    cache.fetch().catch(() => {}); // never awaited: a later request shows it
    for (const [d, t] of days) byDay.set(d, (byDay.get(d) ?? 0) + t);
    return {
      k, root: e.root, repo: p.config.repo, missing: false, running,
      pid: running ? live.pid : null, workers: running ? live.workers : null,
      sessions: running ? live.sessions.map((s) => ({ issue: s.number, role: s.kind, since: s.since })) : [],
      paused: readPause(dir), gate: g ? { ok: g.ok, sha: g.sha, at: g.at } : null,
      rateLimit: running ? live.rateLimit ?? null : null,
      tokens: { today: todayTokens, total },
      board: seen.plan ? boardCounts(seen.plan) : null,
      ...(seen.error !== undefined ? { boardError: seen.error } : {}),
    };
  } catch { return missing; }
}

/** The list only grows while the server runs, so k always names the same root; k is an index, never a path. */
export async function serveFleetDashboard(opts: { port?: number; open?: boolean } = {}): Promise<DashboardServer> {
  const html = readFileSync(HTML_FILE, 'utf8');
  const fleetHtml = readFileSync(FLEET_HTML_FILE, 'utf8');
  let list: ListedRepo[] = [];
  const caches = new Map<number, BoardCache>(); // one per entry, shared by /api/fleet and /repo/<k>/api/...
  const board = (k: number) => (p: Project) => caches.get(k) ?? caches.set(k, boardCache(p)).get(k)!;
  const refresh = () => {
    const f = fleetOrEmpty();
    let seen: unknown[] = [];
    try { seen = readRepos()?.repos ?? []; } catch {}
    list = listRepos(f.fleet.repos, seen, list);
    return f;
  };
  refresh();

  return serve(async (route, res) => {
    if (route === '/') return send(res, 200, 'text/html; charset=utf-8', fleetHtml, { 'Content-Security-Policy': CSP });
    if (route === '/api/fleet') {
      const f = refresh();
      const byDay = new Map<string, number>();
      const today = localDay(new Date().toISOString());
      const repos = list.map((e, k) => fleetEntry(k, e, board(k), byDay, today));
      const dir = fleetDir();
      return json(res, 200, {
        at: new Date().toISOString(),
        fleet: { slotsInUse: slotsInUse(dir), fleetWorkers: f.workers, hold: readHold(dir),
          tokensByDay: [...byDay].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, tokens]) => ({ key, tokens })) },
        repos,
      });
    }
    const m = /^\/repo\/(\d+)(\/.*)$/.exec(route);
    const k = m ? Number(m[1]) : -1;
    const e = k >= 0 && k < list.length ? list[k] : undefined;
    const p = e ? projectAt(e.root) : null;
    if (!m || !p || !(await repoRoute(p, board(k)(p), html, m[2], res))) send(res, 404, TEXT, 'not found\n');
  }, opts);
}

/** Open the page in the default browser: no shell, and only the URL we built. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}
