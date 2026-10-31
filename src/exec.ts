import { execFile, execFileSync, spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A .js/.mjs "binary" (the test fakes for gh and claude) runs under this node, since there is no shell. */
export function resolveCmd(cmd: string, args: string[]): [string, string[]] {
  return /\.m?js$/i.test(cmd) ? [process.execPath, [cmd, ...args]] : [cmd, args];
}

/** Run a program (no shell, so no quoting surprises on Windows) and capture its output. */
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      ...resolveCmd(cmd, args),
      { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
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

/** Kill a process and everything it started (a shell's children outlive a plain kill of the shell).
 *  `killed` is called once the kill has finished (on Windows: when taskkill exits). */
export function killTree(pid: number | undefined, sync = false, killed?: () => void): void {
  if (!pid) { killed?.(); return; }
  if (process.platform === 'win32') {
    if (sync) { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} killed?.(); }
    else execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => killed?.());
  } else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } killed?.(); }
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
      // never block the event loop on taskkill (seconds on a loaded machine): resolve once the tree is
      // killed, not on 'close', which may come while a grandchild with its own stdio still runs
      killTree(child.pid, false, () => done(130));
      setTimeout(() => done(130), 4000).unref(); // a taskkill that hangs does not hold up the abort
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { err += String(e.message); done(1); });
    child.on('close', (code) => { if (!aborted) done(code ?? 1); });
  });
}
