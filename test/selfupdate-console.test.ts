// #472: a runner restart() starts must not hold the old runner's console. On Windows the handles it inherits die with
// the old runner (a detached process is not attached to that console), and the new runner's next console.log throws
// EBADF: an uncaught exception, exit 1, no exit.json, no rollback. Here the old runner is a child of the test with its
// stdout and stderr on pipes: they end once every process holding them has exited, so they end while the new runner
// still runs only if the new runner did not inherit them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { pidAlive } = await import('../src/runstate.ts');
const { runnerOutFile } = await import('../src/selfupdate.ts');

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return ok();
};

test("a self-updated runner does not hold the old runner's stdout and stderr: it outlives the old runner, its output goes to .hx/runner.out", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-472-'));
  const root = path.join(tmp, 'hx'), stateDir = path.join(tmp, '.hx');
  mkdirSync(path.join(root, 'bin'), { recursive: true }); mkdirSync(stateDir);
  // the new runner: ready at once, then on `go` one stdout line and one stderr line; `alive` a second later
  writeFileSync(path.join(root, 'bin', 'hx.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
writeFileSync(process.env.HX_SELFUPDATE_READY, String(process.pid));
const t = setInterval(() => {
  if (!existsSync(path.join(dir, 'go'))) return;
  clearInterval(t);
  console.log('board empty — watching for new issues');
  console.error('(node) Warning: something');
  setTimeout(() => writeFileSync(path.join(dir, 'alive'), String(process.pid)), 1000);
}, 50);
`);
  // the old runner: restart() into the new one, print its pid, exit
  const old = path.join(tmp, 'old.mjs');
  writeFileSync(old, `
const { restart } = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'src', 'selfupdate.ts')).href)});
const r = await restart({ root: ${JSON.stringify(root)}, args: [${JSON.stringify(tmp)}], cwd: ${JSON.stringify(tmp)}, stateDir: ${JSON.stringify(stateDir)}, timeoutMs: 30_000 });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
`);
  const child = spawn(process.execPath, [old], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', ended = 0;
  child.stdout.on('data', (d) => { out += d; });
  child.stdout.on('end', () => ended++); child.stderr.on('end', () => ended++); child.stderr.resume();
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 0, out);
  const pid: number = JSON.parse(out.trim().split('\n').pop()!).pid;
  try {
    // the new runner waits for `go`: its old runner's pipes end now, or only when it exits
    await until(() => ended === 2, 15_000);
    assert.ok(pidAlive(pid), 'the new runner is still running');
    assert.equal(ended, 2, `the old runner exited but its stdout and stderr stay open: the new runner (pid ${pid}) inherited them`);
    // it writes to its console after the old runner is gone, and lives: both lines are in runner.out
    writeFileSync(path.join(tmp, 'go'), '');
    assert.ok(await until(() => existsSync(path.join(tmp, 'alive')), 20_000), 'the new runner survived its console writes');
    assert.equal(readFileSync(path.join(tmp, 'alive'), 'utf8'), String(pid));
    const runnerOut = readFileSync(runnerOutFile(stateDir), 'utf8');
    assert.match(runnerOut, /^board empty — watching for new issues$/m, 'stdout is in runner.out');
    assert.match(runnerOut, /^\(node\) Warning: something$/m, 'stderr is in runner.out');
  } finally {
    writeFileSync(path.join(tmp, 'go'), '');
    await until(() => !pidAlive(pid), 10_000);
    if (pidAlive(pid)) process.kill(pid);
  }
});

test('restart(): a runner.out past 1 MiB becomes runner.out.1 before the new runner starts', { timeout: 60_000 }, async () => {
  const { restart } = await import('../src/selfupdate.ts');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-472b-'));
  const root = path.join(tmp, 'hx'), stateDir = path.join(tmp, '.hx');
  mkdirSync(path.join(root, 'bin'), { recursive: true }); mkdirSync(stateDir);
  writeFileSync(path.join(root, 'bin', 'hx.mjs'), `
import { writeFileSync } from 'node:fs';
console.log('new runner up');
writeFileSync(process.env.HX_SELFUPDATE_READY, String(process.pid));
`);
  writeFileSync(runnerOutFile(stateDir), 'old\n'.repeat(300_000)); // 1.2 MB
  const r = await restart({ root, args: [], cwd: tmp, stateDir, timeoutMs: 30_000 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(await until(() => !pidAlive((r as { pid: number }).pid), 20_000), 'the new runner ended');
  assert.equal(readFileSync(runnerOutFile(stateDir), 'utf8'), 'new runner up\n');
  assert.ok(readFileSync(`${runnerOutFile(stateDir)}.1`, 'utf8').startsWith('old\nold\n'));
});
