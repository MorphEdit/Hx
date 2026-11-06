// The issue states in the dashboard state (#372, PRD #367): `issues` from the last board plan, live.json's sessions and run.log.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS } from '../src/config.ts';

const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const iso = (h: number, m = 0) => new Date(ms(h, m)).toISOString();
const NOW = ms(15);

function fixture(plan: object | undefined) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dis-'));
  const stateDir = path.join(tmp, '.hx');
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, 'run.log'), [
    `${iso(13)} [#7] impl: T7`, `${iso(13, 30)} [#7] audit 2/4: PR #9`,
    `${iso(10)} [#5] impl: T5`, `${iso(11)} [#5] impl DONE ✓ (1.0M tokens)`,
  ].join('\n') + '\n');
  writeFileSync(path.join(stateDir, 'live.json'), JSON.stringify({ pid: process.pid, startedAt: iso(9), repo: 'me/app', workers: 3, draining: false,
    sessions: [{ key: 'issue:7', number: 7, kind: 'impl', title: 'T7', since: iso(13), turn: 1, tokens: 0 }] }));
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), auditRounds: 4 };
  return dashboardState({ root: tmp, stateDir, config } as any, () => ({ plan } as any), NOW) as any;
}

test('dashboardState carries issues: groups and items from the board plan, the live sessions and run.log', E2E, () => {
  const s = fixture({ prds: [], board: [{ number: 7, title: 'T7', status: 'working', waitingOn: [] },
    { number: 8, title: 'T8', status: 'waiting', waitingOn: [{ repo: 'me/app', number: 7 }] }], parents: {}, questions: [], actions: [] });
  assert.deepEqual(s.issues.groups, [{ key: 'other', title: 'Other issues', progress: '2' }, { key: 'closed', title: 'Closed today', progress: '1' }]);
  assert.deepEqual(s.issues.items.map((i: any) => [i.number, i.group, i.status, i.round, i.pr, i.worker, i.waitsOn]), [
    [7, 'other', 'auditing', '2 of 4', '#9', 'W1', []],
    [8, 'other', 'waiting', '1 of 4', 'not yet', '—', ['#7']],
    [5, 'closed', 'done', '1 of 4', 'not yet', '—', []],
  ]);
});

test('dashboardState carries issues before the first board read', E2E, () => {
  const s = fixture(undefined);
  assert.deepEqual(s.issues.items.map((i: any) => [i.number, i.group]), [[7, 'other'], [5, 'closed']]);
});
