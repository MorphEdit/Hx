// A stand-in for bin/hx.mjs under `hx supervise`: appends its argv and cwd to <cwd>/runs.log, takes the first exit code
// from <cwd>/codes.json (default 0), waits <cwd>/up-ms milliseconds (default 0), then exits with that code.
// <cwd>/handover.json (taken by the first run that finds it) makes that run hand over as a self-update does: it starts
// a detached "new runner" with the spec, waits until it owns .hx/live.json, and exits 0. The new runner (HX_FAKE_NEW:
// the spec) waits until .hx/supervise.json says the supervisor watches it, holds the lock for `upMs`, then hands over again (`again`: the next spec) or clears the lock, records
// `code` in .hx/exit.json unless `record` is false, and exits with it; `die`: it is killed instead, its lock left behind and
// no exit recorded (#472). Each new runner appends its pid to <cwd>/new.log.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const live = '.hx/live.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function handOver(spec) {
  const kid = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', env: { ...process.env, HX_FAKE_NEW: JSON.stringify(spec) } });
  kid.unref();
  for (let i = 0; i < 200; i++) { // up to 20 s
    try { if (JSON.parse(readFileSync(live, 'utf8')).pid === kid.pid) return; } catch {}
    await sleep(100);
  }
}
const watched = () => {
  try { return JSON.parse(readFileSync('.hx/supervise.json', 'utf8')).last.line.endsWith(`pid ${process.pid} — watching it`); } catch { return false; }
};

if (process.env.HX_FAKE_NEW) {
  const spec = JSON.parse(process.env.HX_FAKE_NEW);
  writeFileSync(live, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] }));
  appendFileSync('new.log', `${process.pid}\n`);
  // the lock is held until the supervisor says it watches this runner: the order of events, not the time, decides (#322)
  for (let i = 0; i < 200 && !watched(); i++) await sleep(100); // up to 20 s
  await sleep(spec.upMs ?? 300);
  if (spec.again) { await handOver(spec.again); process.exit(0); }
  if (spec.die) process.kill(process.pid, 'SIGKILL');
  rmSync(live, { force: true });
  if (spec.record !== false) writeFileSync('.hx/exit.json', JSON.stringify({ pid: process.pid, code: spec.code ?? 0, at: new Date().toISOString() }));
  process.exit(spec.code ?? 0);
}

appendFileSync('runs.log', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), at: Date.now() }) + '\n');
const codes = existsSync('codes.json') ? JSON.parse(readFileSync('codes.json', 'utf8')) : [];
const code = codes.length ? codes.shift() : 0;
writeFileSync('codes.json', JSON.stringify(codes));
if (existsSync('handover.json')) {
  const spec = JSON.parse(readFileSync('handover.json', 'utf8'));
  rmSync('handover.json');
  await handOver(spec);
  process.exit(0);
}
const up = existsSync('up-ms') ? Number(readFileSync('up-ms', 'utf8')) : 0;
setTimeout(() => process.exit(code), up);
