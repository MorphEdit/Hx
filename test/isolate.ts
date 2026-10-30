// Imported first by every end-to-end test file: nothing from a live `hx run` on the same machine (its
// environment, inherited by the worker that runs these tests) or from the user's git setup reaches them.
// A hung test fails at E2E.timeout instead of blocking `node --test`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HX_GH_BIN, HX_GIT_BIN, HX_SHIP_*, HX_FAKE_*, FAKE_CLAUDE_* … each test file sets the ones it needs
for (const k of Object.keys(process.env)) if (/^(HX_|FAKE_)/i.test(k)) delete process.env[k];
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete process.env[k];

// git: no user/system config (signing, hooks, credential helpers, pagers), never a prompt
const gitHome = mkdtempSync(path.join(os.tmpdir(), 'hx-git-'));
writeFileSync(path.join(gitHome, 'config'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(gitHome, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_EDITOR: 'true', GIT_PAGER: 'cat',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

export const E2E = { timeout: 120_000 };

/** The pid of a process that has exited: a crashed runner. A made-up number may be a live process
 *  (Windows ignores the low two bits of a pid, so 999999 is 999996). */
export const deadPid = (): number => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** What the fake claude recorded of every session turn in fakeDir: its role, whether it was a checkpoint, its HX_TRUSTED and PATH. */
export function sessionEnvs(fakeDir: string): { role: string; checkpoint: boolean; trusted: string | null; path: string | null }[] {
  return readdirSync(fakeDir).filter((f) => /\.env-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')));
}
