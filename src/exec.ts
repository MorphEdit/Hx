import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A .js/.mjs "binary" (the test fakes for gh and claude) runs under this node, since there is no shell. */
export function resolveCmd(cmd: string, args: string[]): [string, string[]] {
  return /\.m?js$/i.test(cmd) ? [process.execPath, [cmd, ...args]] : [cmd, args];
}

/** windowsHide for a child: a hidden console of its own, so no window flashes when hx has no console to share (a
 *  fleet's detached runner). It costs ~200 ms per spawn on Windows; HX_SHARE_CONSOLE=1 (the tests: thousands of gh,
 *  git and claude calls from a console they can share) lets children share the parent's console instead. */
export const hideWindow = (): boolean => process.env.HX_SHARE_CONSOLE !== '1';

/** HX_GH_INPROC (set by the tests): the fake gh it names runs in-process through its exported gh(), the same answers
 *  without a node start per call; null = run it as a program (another command, or a call the fake keeps out of process). */
export async function inProcess(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<ExecResult | null> {
  const file = process.env.HX_GH_INPROC;
  if (!file || !/.m?js$/i.test(cmd) || path.resolve(cmd) !== path.resolve(file)) return null;
  const { gh } = await import(pathToFileURL(path.resolve(file)).href);
  await new Promise((r) => setImmediate(r)); // answers on a later turn of the event loop, as a child would
  return gh(args, { input: () => opts.input ?? '', cwd: opts.cwd ?? process.cwd(), inProcess: true });
}

/** Run a program (no shell, so no quoting surprises on Windows) and capture its output. */
export async function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<ExecResult> {
  const fake = await inProcess(cmd, args, opts);
  if (fake) return fake;
  return new Promise((resolve) => {
    const child = execFile(
      ...resolveCmd(cmd, args),
      { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: hideWindow(), encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || (err && !stderr ? String(err.message) : '') });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function runOk(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

/** Kill a process and everything it started (a shell's children outlive a plain kill of the shell). */
export function killTree(pid: number | undefined, sync = false, onKilled?: () => void): void {
  if (!pid) { onKilled?.(); return; }
  if (process.platform === 'win32') {
    if (sync) try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    else { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => onKilled?.()); return; }
  } else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  onKilled?.();
}

export interface Proc { pid: number; ppid: number; cmd: string }

/** Every process this user can see, with its parent and command line: Win32_Process on Windows, ps elsewhere. A
 *  query that fails or lists nothing (WMI busy on a loaded machine) is tried again, up to three times. */
export async function listProcesses(tries = 3): Promise<Proc[]> {
  for (let i = 0; i < tries; i++) {
    const procs = await queryProcesses();
    if (procs.length) return procs;
  }
  return [];
}

/** The Win32_Process query. PowerShell writes its output in the console code page, where a character outside it
 *  (`→` in another worker's Bash call) is a raw 0x1A byte that breaks the JSON; so every non-ASCII UTF-16 unit is
 *  written as a \uXXXX escape and the output is plain ASCII, whatever the code page (#328). */
export const WIN_PS_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
  + String.raw` | ForEach-Object { [regex]::Replace($_, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }) }`;

/** The processes in ConvertTo-Json's output (an array, or one object for a single process). A control byte inside a
 *  string (what a code page makes of a character it lacks) is escaped first, so one odd command line never empties
 *  the whole listing; output that is still not JSON is []. */
export function parseProcessJson(text: string): Proc[] {
  const t = text.trim().replace(/[\u0000-\u001f]/g, (c) => String.raw`\u` + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    return (Array.isArray(j) ? j : [j]).filter((x: any) => x && typeof x === 'object')
      .map((x: any) => ({ pid: Number(x.ProcessId), ppid: Number(x.ParentProcessId), cmd: String(x.CommandLine ?? '') }));
  } catch { return []; }
}

/** One process query (listProcesses tries it again when it lists nothing). */
export async function queryProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_QUERY]);
    return r.code === 0 ? parseProcessJson(r.stdout) : [];
  }
  const r = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}

/** Whether a command line names a path inside `dir`: dir followed by a separator, a quote, a space or the end, in
 *  its `\` and `/` forms (case-insensitive on Windows), so i28 never matches i285. */
export function namesDir(cmd: string, dir: string): boolean {
  const d = path.resolve(dir).replace(/[\\/]+$/, '');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [...new Set([d.replace(/\//g, '\\'), d.replace(/\\/g, '/')])].map(esc).join('|');
  return new RegExp(`(?:${forms})(?:[\\\\/"' ]|$)`, process.platform === 'win32' ? 'i' : '').test(cmd);
}

/** The processes whose command line names a path inside `dir`; never `self` or one of its ancestors. */
export function procsInDir(procs: Proc[], dir: string, self = process.pid): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const spare = new Set<number>([self]);
  for (let p = byPid.get(self); p && p.ppid && !spare.has(p.ppid); p = byPid.get(p.ppid)) spare.add(p.ppid);
  return procs.filter((p) => p.pid > 0 && !spare.has(p.pid) && namesDir(p.cmd, dir)).map((p) => p.pid);
}

/** Whether `dir` is strictly inside `root`. */
export function isInside(dir: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Kill, with their trees, the processes whose command line names a path inside `dir` (#328): what a session's
 *  agent started outlives taskkill /T once the step between them has exited. A `dir` outside `root` (the worktree
 *  root) is refused. Returns the number of processes killed. */
export async function killByPath(dir: string, root: string, procs?: Proc[]): Promise<number> {
  if (!isInside(dir, root)) return 0;
  const pids = procsInDir(procs ?? await listProcesses(), dir);
  await Promise.all(pids.map((pid) => new Promise<void>((gone) => killTree(pid, false, gone))));
  return pids.length;
}

/** The pids under `roots` by parent id, at any depth, the roots themselves left out. Windows keeps an exited
 *  parent's id on its children, so a root that is gone still finds what it started. */
export function descendants(procs: Proc[], roots: Iterable<number>): number[] {
  const kids = new Map<number, number[]>();
  for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const seen = new Set<number>(roots), out: number[] = [];
  for (const queue = [...seen]; queue.length;) {
    for (const k of kids.get(queue.shift()!) ?? []) if (!seen.has(k)) { seen.add(k); out.push(k); queue.push(k); }
  }
  return out;
}

/** Kill `pid`'s tree, then, pass by pass, what it left behind: a process started while taskkill /T ran, or whose
 *  parent was killed before it, is out of taskkill's reach but still names a killed pid as its parent. Ends after a
 *  pass that finds nothing new, or after `passes`. Returns every pid it killed beyond `pid`. */
export async function killTreeSwept(pid: number, o: { list?: () => Promise<Proc[]>; kill?: (pid: number) => Promise<void>; passes?: number } = {}): Promise<number[]> {
  const list = o.list ?? (() => listProcesses());
  const kill = o.kill ?? ((p: number) => new Promise<void>((gone) => killTree(p, false, gone)));
  const known = new Set<number>([pid, ...descendants(await list(), [pid])]);
  await kill(pid);
  for (let i = 0; i < (o.passes ?? 5); i++) {
    const left = descendants(await list(), known);
    if (!left.length) break;
    for (const p of left) known.add(p);
    await Promise.all(left.map(kill));
  }
  known.delete(pid);
  return [...known];
}

export interface ShellResult {
  code: number;
  output: string; // stdout then stderr, the last 1 MB of each
  timedOut: boolean;
  aborted?: boolean; // opts.signal fired: the process tree was killed
  killed?: Promise<void>; // after an abort: settles once the tree is gone (awaited already unless opts.killLater)
  pid?: number;
}

/** Run a shell command line; after `timeoutMs`, or when `signal` aborts, the whole process tree is killed
 *  and `timedOut` / `aborted` is set. An abort settles once the tree is gone; with `killLater` it settles at
 *  once and `killed` is that wait (taskkill alone takes seconds on a loaded Windows machine). With `sweep`, a
 *  time limit kills with killTreeSwept and settles once that is done: nothing the command started keeps running
 *  in its directory (a process started while the tree was killed would hold it on Windows). */
export function runShell(command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; killLater?: boolean; env?: Record<string, string>; sweep?: boolean }): Promise<ShellResult> {
  // already aborted: nothing to start, so nothing to kill (a taskkill under load would take seconds)
  if (opts.signal?.aborted) return Promise.resolve({ code: 130, output: '', timedOut: false, aborted: true, killed: Promise.resolve() });
  return new Promise((resolve) => {
    const child = spawn(command, [], { cwd: opts.cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}), detached: process.platform !== 'win32' }); // its own process group, so the tree can be killed elsewhere
    const keep = (s: string, d: Buffer) => (s + d.toString()).slice(-1024 * 1024);
    let out = '', err = '', timedOut = false, aborted = false, settled = false;
    let killed: Promise<void> | undefined, swept: Promise<unknown> | undefined;
    child.stdout.on('data', (d: Buffer) => { out = keep(out, d); });
    child.stderr.on('data', (d: Buffer) => { err = keep(err, d); });
    const done = (code: number) => {
      if (settled) return;
      settled = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
      const result = () => resolve({ code: aborted ? 130 : timedOut ? 124 : code, output: `${out}\n${err}`, timedOut, ...(aborted ? { aborted } : {}), ...(killed ? { killed } : {}), pid: child.pid });
      if (swept) swept.then(result); else result();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (opts.sweep) {
        const cap = new Promise((r) => setTimeout(r, 60_000).unref()); // in case a process query hangs
        swept = Promise.race([killTreeSwept(child.pid!).catch(() => []), cap]);
        swept.then(() => done(124));
        return;
      }
      killTree(child.pid, true);
      setTimeout(() => done(124), 5000).unref(); // a stray grandchild may still hold the pipes open
    }, opts.timeoutMs);
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true; clearTimeout(timer);
      // async: a sync taskkill under load blocks the event loop for seconds; settle once the tree is gone,
      // not on 'close' — a grandchild holding the pipes open would keep it from firing
      killed = new Promise<void>((gone) => {
        killTree(child.pid, false, gone);
        setTimeout(gone, 10_000).unref(); // in case taskkill itself hangs
      });
      if (opts.killLater) done(130); else killed.then(() => done(130));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { err += String(e.message); done(1); });
    child.on('close', (code) => done(code ?? 1));
  });
}
