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

export interface ShellResult {
  code: number;
  output: string; // stdout then stderr, the last 1 MB of each
  timedOut: boolean;
  aborted?: boolean; // opts.signal fired: the process tree was killed
  pid?: number;
}

/** Run a shell command line; after `timeoutMs`, or when `signal` aborts, the whole process tree is killed
 *  and `timedOut` / `aborted` is set. */
export function runShell(command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { cwd: opts.cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' }); // its own process group, so the tree can be killed elsewhere
    const keep = (s: string, d: Buffer) => (s + d.toString()).slice(-1024 * 1024);
    let out = '', err = '', timedOut = false, aborted = false, settled = false;
    child.stdout.on('data', (d: Buffer) => { out = keep(out, d); });
    child.stderr.on('data', (d: Buffer) => { err = keep(err, d); });
    const done = (code: number) => {
      if (settled) return;
      settled = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: aborted ? 130 : timedOut ? 124 : code, output: `${out}\n${err}`, timedOut, ...(aborted ? { aborted } : {}), pid: child.pid });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, true);
      setTimeout(() => done(124), 5000).unref(); // a stray grandchild may still hold the pipes open
    }, opts.timeoutMs);
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true; clearTimeout(timer);
      // async: a sync taskkill under load blocks the event loop for seconds; settle once the tree is gone,
      // not on 'close' — a grandchild holding the pipes open would keep it from firing
      killTree(child.pid, false, () => done(130));
      setTimeout(() => done(130), 10_000).unref(); // in case taskkill itself hangs
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { err += String(e.message); done(1); });
    child.on('close', (code) => done(code ?? 1));
  });
}
