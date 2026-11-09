// hx prd end to end: the real CLI (bin/hx.mjs) with fake gh files a PRD, writes .hx/wake and prints the closing line.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { writeLive } from '../src/runstate.ts';
import { DIRECT_MAX_CRITERIA } from '../src/tiers.ts';
const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-prdc-'));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const D = 'It will be decomposed into issues. ';
const PICK = `hx run (pid ${process.pid}) will pick it up now.`;
const NONE = 'no hx run is running — start it with  hx run --watch';
const stateFile = path.join(tmp, 'board.json');
const root = path.join(tmp, 'app');
const hxDir = path.join(root, '.hx');
mkdirSync(root);
saveConfig(hxDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main' });

function hx(args: string[]) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile } });
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\r\n/g, '\n') };
}

test('hx prd <file>: filed <url>, then the decompose lane and the runner line; .hx/wake written', E2E, () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  rmSync(path.join(hxDir, 'wake'), { force: true });
  const file = path.join(tmp, 'feature.md');
  writeFileSync(file, '# A feature\n\nGoals.\n');
  writeLive(hxDir, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  let r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/1\n${D}${PICK}\n`), r.out);
  assert.match(readFileSync(path.join(hxDir, 'wake'), 'utf8').trim(), ISO);

  rmSync(path.join(hxDir, 'live.json'));
  r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/2\n${D}${NONE}\n`), r.out);
});

test('hx prd with a missing file: nothing filed, no .hx/wake', E2E, () => {
  rmSync(path.join(hxDir, 'wake'), { force: true });
  const r = hx(['prd', path.join(tmp, 'nope.md')]);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(!existsSync(path.join(hxDir, 'wake')));
});

const criteria = (n: number) => Array.from({ length: n }, (_, i) => `- [ ] criterion ${i + 1}\n  wrapped line`).join('\n');
const hint = (n: number) => `note: ${n} acceptance criteria (Direct tier: at most ${DIRECT_MAX_CRITERIA}) — this work may fit one session`;
const issues = () => JSON.parse(readFileSync(stateFile, 'utf8')).issues;

test('hx prd: at most DIRECT_MAX_CRITERIA criteria prints the Direct-tier hint after filed <url>, and still files', E2E, () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  rmSync(path.join(hxDir, 'live.json'), { force: true });
  const file = path.join(tmp, 'small.md');
  writeFileSync(file, `# Small\n\n## Acceptance criteria\n\n${criteria(DIRECT_MAX_CRITERIA)}\n\n## Quality bar\n\n- a\n- b\n`);
  let r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/1\n${hint(DIRECT_MAX_CRITERIA)}\n${D}${NONE}\n`), r.out);
  assert.equal(issues().length, 1);

  writeFileSync(file, '# One\n\n## Acceptance criteria\n\n1. it works\n');
  r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/2\n${hint(1)}\n${D}${NONE}\n`), r.out);
  assert.equal(issues().length, 2);
});

test('hx prd: more than DIRECT_MAX_CRITERIA criteria, or no Acceptance criteria list, prints no hint', E2E, () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  rmSync(path.join(hxDir, 'live.json'), { force: true });
  const file = path.join(tmp, 'big.md');
  writeFileSync(file, `# Big\n\n## Acceptance criteria\n\n${criteria(DIRECT_MAX_CRITERIA + 1)}\n`);
  let r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/1\n${D}${NONE}\n`), r.out);
  assert.ok(!r.out.includes('note:'), r.out);

  writeFileSync(file, '# None\n\nGoals.\n\n- a bullet outside any criteria section\n');
  r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/2\n${D}${NONE}\n`), r.out);
  assert.ok(!r.out.includes('note:'), r.out);

  writeFileSync(file, '# Empty\n\n## Acceptance criteria\n\nIt works.\n');
  r = hx(['prd', file]);
  assert.ok(r.out.includes(`filed https://github.com/me/app/issues/3\n${D}${NONE}\n`), r.out);
  assert.ok(!r.out.includes('note:'), r.out);
  assert.equal(issues().length, 3);
});
