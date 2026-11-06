// The control-room events in the dashboard state (#370, PRD #367): `events` built from a fixture .hx/'s run.log.1 then
// run.log, today's lines only (the local day of `now`), with the config's blocked label.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS } from '../src/config.ts';

const at = (h: number, m = 0, day = 7) => new Date(2026, 10, day, h, m).toISOString();
const NOW = new Date(2026, 10, 7, 15, 0).getTime();

test('dashboardState carries events from run.log.1 then run.log, today only', E2E, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-devt-'));
  const stateDir = path.join(tmp, '.hx');
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, 'run.log.1'), [
    `${at(18, 0, 6)} [#3] audit PASS ✓`,                                    // yesterday: left out
    `${at(9)} [#4] impl: Add the thing`,
    `${at(9, 30)} [#4] impl turn 1: ok · 1.2M tokens (30K out) · 600s`,
  ].join('\n') + '\n');
  writeFileSync(path.join(stateDir, 'run.log'), [
    `${at(10)} [#4] audit 1/3: PR #9`,
    `${at(11)} [#4] review round cap (3) reached — labelled stuck`,
    `${at(12)} [#4] DONE ✓ audited and merged (1 round(s), 2 turn(s), 2.5M tokens)`,
  ].join('\n') + '\n');
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), labels: { ...DEFAULTS.labels, blocked: 'stuck' } };
  const s = dashboardState({ root: tmp, stateDir, config } as any, () => ({}), NOW) as any;
  assert.deepEqual(s.events, [
    { t: at(9), issue: 4, step: 'Implement', text: 'impl: Add the thing', tokens: null, kind: 'info' },
    { t: at(9, 30), issue: 4, step: 'Implement', text: 'impl turn 1: ok · 1.2M tokens (30K out) · 600s', tokens: 1_200_000, kind: 'info' },
    { t: at(10), issue: 4, step: 'Audit', text: 'audit 1/3: PR #9', tokens: null, kind: 'info' },
    { t: at(11), issue: 4, step: 'Review', text: 'review round cap (3) reached — labelled stuck', tokens: null, kind: 'problem' },
    { t: at(12), issue: 4, step: 'Merge', text: 'DONE ✓ audited and merged', tokens: 2_500_000, kind: 'result' },
  ]);
});
