import { execFile } from 'node:child_process';

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
