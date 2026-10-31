// Imported first by every end-to-end test file: nothing from a live `hx run` on the same machine (its
// environment, inherited by the worker that runs these tests) or from the user's git setup reaches them.
// A hung test fails at E2E.timeout instead of blocking `node --test`.
import { afterEach } from 'node:test';
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

// 5 min: a test that takes 10-25 s alone runs past 2 min when the gate shares the machine with busy workers
export const E2E = { timeout: 300_000 };

// A pool a test starts stops when the test ends. A test that times out leaves its function running: without
// this, its pool would go on claiming and building on the board the next test writes, failing that test too.
let testEnded = new AbortController();
const pools = new Set<Promise<unknown>>();

/** Run a pool (or anything that takes a stop signal) on a signal aborted when the current test ends, a timeout
 *  included; `also` (a test's own Ctrl+C) aborts it too. The next test starts once it has stopped. */
export function pooled<T>(start: (signal: AbortSignal) => Promise<T>, also?: AbortSignal): Promise<T> {
  const p = start(also ? AbortSignal.any([testEnded.signal, also]) : testEnded.signal);
  pools.add(p);
  p.then(() => pools.delete(p), () => pools.delete(p));
  return p;
}

// only in a test file: a hook registered elsewhere (a script importing this file) would start a test harness
if (/\.test\.ts$/.test(process.argv[1] ?? '')) afterEach(async () => {
  testEnded.abort();
  await Promise.allSettled([...pools]);
  testEnded = new AbortController();
}, E2E);

/** A pid no process can have: a crashed runner. The pid of a process that has exited is not enough: Windows
 *  reuses pids within seconds while the full suite spawns hundreds of processes, and a reused pid reads as a
 *  runner that is still alive. A small made-up number may be live too (Windows ignores the low two bits of a
 *  pid, so 999999 is 999996). 0x7ffffffc is a multiple of four far above any pid Windows hands out, and above
 *  Linux's pid_max (2^22). */
export const deadPid = (): number => 0x7ffffffc;

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** What the fake claude recorded of every session turn in fakeDir: its role, whether it was a checkpoint, its HX_TRUSTED and PATH. */
export function sessionEnvs(fakeDir: string): { role: string; checkpoint: boolean; trusted: string | null; path: string | null }[] {
  return readdirSync(fakeDir).filter((f) => /\.env-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')));
}
