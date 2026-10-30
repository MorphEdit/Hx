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

/** Kill a process and everything it started (a shell's children outlive a plain kill of the shell). */
export function killTree(pid: number | undefined, sync = false): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    if (sync) try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    else execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

export interface ShellResult {
  code: number;
  output: string; // stdout then stderr, the last 1 MB of each
  timedOut: boolean;
  pid?: number;
}

/** Run a shell command line; after `timeoutMs` the whole process tree is killed and `timedOut` is set. */
export function runShell(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { cwd: opts.cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' }); // its own process group, so the tree can be killed elsewhere
    const keep = (s: string, d: Buffer) => (s + d.toString()).slice(-1024 * 1024);
    let out = '', err = '', timedOut = false, settled = false;
    child.stdout.on('data', (d: Buffer) => { out = keep(out, d); });
    child.stderr.on('data', (d: Buffer) => { err = keep(err, d); });
    const done = (code: number) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, output: `${out}\n${err}`, timedOut, pid: child.pid });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, true);
      setTimeout(() => done(124), 5000).unref(); // a stray grandchild may still hold the pipes open
    }, opts.timeoutMs);
    child.on('error', (e) => { err += String(e.message); done(1); });
    child.on('close', (code) => done(code ?? 1));
  });
}
