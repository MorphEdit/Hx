// Usage by day groups by the local date (machine time zone): the dashboard's byDay and hx usage --by day.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-day-'));
const stateDir = path.join(tmp, '.hx');
mkdirSync(stateDir);
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
saveConfig(stateDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') });
const rec = (ts: string, tokens: number) => ({ ts, issue: 1, role: 'impl', sessionId: `s${ts}`, iteration: 1, model: 'claude-opus-5-5', ok: true,
  usage: { input: tokens, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 0, numTurns: 1 });
// 2026-10-30T20:00Z is 03:00 on 2026-10-31 in Bangkok (UTC+7)
writeFileSync(path.join(stateDir, 'usage.jsonl'), [rec('2026-10-30T20:00:00Z', 100), rec('2026-10-30T10:00:00Z', 5)].map((r) => JSON.stringify(r)).join('\n') + '\n');

const env = { ...process.env, TZ: 'Asia/Bangkok' };
const node = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: tmp, env, encoding: 'utf8' });

test('localDay: the local date in the process time zone, not the UTC date', E2E, () => {
  const url = pathToFileURL(path.join(root, 'src', 'usage.ts')).href;
  const r = node(['--input-type=module', '-e', `import { localDay } from ${JSON.stringify(url)}; console.log(localDay('2026-10-30T20:00:00Z'), localDay('2026-10-30T16:59:59Z'))`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '2026-10-31 2026-10-30');
});

test("TZ=Asia/Bangkok: the dashboard's byDay puts 2026-10-30T20:00Z under 2026-10-31", E2E, () => {
  const url = pathToFileURL(path.join(root, 'src', 'dashboard.ts')).href;
  const cfg = pathToFileURL(path.join(root, 'src', 'config.ts')).href;
  const code = `import { dashboardState } from ${JSON.stringify(url)}; import { loadProject } from ${JSON.stringify(cfg)};
    const s = dashboardState(loadProject(), () => ({})); console.log(JSON.stringify(s.usage.byDay.map((x) => [x.key, x.tokens])));`;
  const r = node(['--input-type=module', '-e', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [['2026-10-31', 100], ['2026-10-30', 5]]);
});

test('TZ=Asia/Bangkok: hx usage --by day puts 2026-10-30T20:00Z under 2026-10-31', E2E, () => {
  const r = node([path.join(root, 'bin', 'hx.mjs'), 'usage', '--by', 'day']);
  assert.equal(r.status, 0, r.stderr);
  const day = (d: string) => r.stdout.split(/\r?\n/).find((l) => l.startsWith(d));
  assert.match(day('2026-10-31') ?? '', /^2026-10-31\s+1\s+1\s+100\b/);
  assert.match(day('2026-10-30') ?? '', /^2026-10-30\s+1\s+1\s+5\b/);
});
