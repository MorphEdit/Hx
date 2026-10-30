// CI gate: the default branch is tested after every merge (and at start). While it is red, hx claims
// nothing except the issue that fixes it — which hx files itself — so no worker builds on a broken base.
// Hx repos usually have no hosted CI, so the gate is local: the project's test command on a fresh
// checkout of origin/<base>.
import { exec } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './exec.ts';
import { addWorktree, removeWorktree } from './worktree.ts';

export interface GateResult {
  sha: string;
  ok: boolean;
  command: string;
  output: string; // tail of the test output
  at: string;
}

export interface GateState {
  command?: string; // learned from the implementer's ship call when config.gateCommand is empty
  last?: GateResult;
  fixIssue?: number; // the open issue hx filed for the current red
}

const file = (stateDir: string) => path.join(stateDir, 'gate.json');

export function readGate(stateDir: string): GateState {
  try { return JSON.parse(readFileSync(file(stateDir), 'utf8')); } catch { return {}; }
}

export function writeGate(stateDir: string, s: GateState): void {
  writeFileSync(file(stateDir), JSON.stringify(s, null, 2));
}

/** The commit origin/<base> points at right now. */
export async function remoteSha(checkout: string, base: string): Promise<string> {
  const r = await run(process.env.HX_GIT_BIN || 'git', ['-C', checkout, 'ls-remote', 'origin', `refs/heads/${base}`]);
  return r.stdout.split(/\s/)[0] ?? '';
}

/** Run `command` on a fresh checkout of origin/<base>. */
export async function runGate(checkout: string, root: string, base: string, command: string, timeoutMs = 20 * 60_000): Promise<GateResult> {
  const wt = await addWorktree(checkout, root, { name: 'gate', branch: 'hx/gate', base, fresh: true });
  try {
    const sha = (await run(process.env.HX_GIT_BIN || 'git', ['-C', wt.dir, 'rev-parse', 'HEAD'])).stdout.trim();
    const res = await new Promise<{ code: number; out: string }>((resolve) => {
      exec(command, { cwd: wt.dir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: `${stdout}\n${stderr}` }));
    });
    return { sha, ok: res.code === 0, command, output: res.out.trim().split('\n').slice(-60).join('\n'), at: new Date().toISOString() };
  } finally {
    await removeWorktree(checkout, wt.dir);
  }
}

export const gateIssueTitle = (base: string, r: GateResult) => `Default branch is red: \`${r.command}\` fails on ${base} at ${r.sha.slice(0, 7)}`;

export const gateIssueBody = (base: string, r: GateResult) => `hx tests \`${base}\` after every merge. At ${r.sha} \`${r.command}\` fails, so hx claims no other work until \`${base}\` is green again.

Make \`${r.command}\` pass on \`${base}\` again: find the cause (\`git log\` shows what merged last), fix it, and
add a test if one was missing. Do not skip, delete or weaken tests to get green.

Output (tail):

\`\`\`
${r.output.slice(-6000)}
\`\`\`

## Blocked by
None
`;
