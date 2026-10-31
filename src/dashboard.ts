// hx dashboard: a read-only page over .hx/ (live.json, usage.jsonl, gate.json, run.log.1 + run.log) and the board.
// Localhost only: it binds 127.0.0.1, answers only a Host of 127.0.0.1:<port> or localhost:<port> (so a
// web page cannot reach it through DNS rebinding), takes GET only and sends no CORS headers.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './config.ts';
import { readGate } from './gate.ts';
import { parseOutcomes } from './outcomes.ts';
import { lookupTrusted, readPlan, runLogFile } from './pool.ts';
import { pidAlive, readLive, readPause } from './runstate.ts';
import type { Plan } from './state.ts';
import { localDay, readUsage, summarize, totalTokens, type UsageRecord, type UsageRow } from './usage.ts';

export const HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
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
function boardCache(p: Project, ttl = BOARD_TTL_MS): { fetch(): Promise<BoardEntry>; seen(): BoardSeen } {
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

/** Reads .hx/ only and never calls gh: usage by PRD comes from the last board /api/board fetched, null before one. */
export function dashboardState(p: Project, board: () => BoardSeen): object {
  const dir = p.stateDir, now = Date.now();
  const live = readLive(dir);
  const running = !!live && pidAlive(live.pid);
  const runner = running ? {
    running: true, pid: live.pid, startedAt: live.startedAt, uptimeMs: now - Date.parse(live.startedAt), workers: live.workers,
    paused: readPause(dir), draining: !!live.draining, pausedUntil: live.pausedUntil ?? null, pauseReason: live.pauseReason ?? null,
    rateLimit: live.rateLimit ?? null,
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
    byModel: rows(recs, (r) => r.model),
    byDay: rows(recs, (r) => localDay(r.ts)),
    byPrd: parents ? rows(recs, (r) => String(parents[r.issue] ?? r.issue)) : null,
    ...(b.error !== undefined ? { boardError: b.error } : {}),
  };

  const logFile = runLogFile(dir);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  // run.log.1 (the one rotated file, when there is one) then run.log, as one line sequence
  const outcomes = parseOutcomes([...read(`${logFile}.1`).split(/\r?\n/), ...read(logFile).split(/\r?\n/)]);
  return { repo: p.config.repo, runner, sessions, gate, usage, log: tailLines(logFile, LOG_LINES), outcomes };
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

export async function serveDashboard(p: Project, opts: { port?: number; open?: boolean } = {}):
  Promise<{ url: string; port: number; address(): AddressInfo; close(): Promise<void> }> {
  const html = readFileSync(HTML_FILE, 'utf8');
  const board = boardCache(p);
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return send(res, 403, TEXT, 'forbidden host\n');
    if (req.method !== 'GET') return send(res, 405, TEXT, 'method not allowed\n', { Allow: 'GET' });
    const route = (req.url ?? '/').split('?')[0];
    if (route === '/') return send(res, 200, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': CSP });
    if (route === '/api/state') return json(res, 200, dashboardState(p, board.seen));
    if (route === '/api/board') {
      const b = await board.fetch();
      return json(res, 200, { at: new Date(b.at).toISOString(), repo: p.config.repo, prds: b.plan?.prds ?? [], board: b.plan?.board ?? [],
        ...(b.error !== undefined ? { error: b.error } : {}) });
    }
    send(res, 404, TEXT, 'not found\n');
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => { if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) }); else res.end(); });
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

/** Open the page in the default browser: no shell, and only the URL we built. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}
