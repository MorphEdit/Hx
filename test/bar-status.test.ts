// The quality bar on hx status and the dashboard (#258): each quality-bar PRD's round and last result from
// its latest trusted round comment; a PRD without the section costs no comment fetch.
import { E2E } from './isolate.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-bs-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_GH_LOG = ghLog;

const { barLine, barMarker, barStatus } = await import('../src/bar.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { boardCounts, serveDashboard } = await import('../src/dashboard.ts');

const L = DEFAULTS.labels;
const SECTION = '\n\n## Quality bar\nBeat: Stripe Billing — https://stripe.com/billing\nJudged on:\n- invoice speed\n';
const GAP = 'Creating an invoice takes four screens where Stripe needs one, and the totals are hidden below the fold on every page';
// #1: at its bar, round 1 lost (a forged won round 2 by a stranger); #3: a bar PRD not run yet; #5: no section
writeFileSync(stateFile, JSON.stringify({ login: 'me', prs: [], issues: [
  { number: 1, title: 'billing', body: `Billing.${SECTION}`, state: 'OPEN', labels: [L.prd, L.hardened, L.reviewed, L.secured] },
  { number: 2, title: 'part', body: 'x\n\n## Parent\n#1\n', state: 'CLOSED', labels: [L.ready] },
  { number: 3, title: 'reports', body: `Reports.${SECTION}`, state: 'OPEN', labels: [L.prd, L.hardened] },
  { number: 4, title: 'part', body: 'y\n\n## Parent\n#3\n', state: 'OPEN', labels: [L.ready] },
  { number: 5, title: 'plain', body: 'No bar here.', state: 'OPEN', labels: [L.prd, L.hardened] },
  { number: 6, title: 'part', body: 'z\n\n## Parent\n#5\n', state: 'OPEN', labels: [L.ready] },
], comments: [
  { issue: 1, body: barMarker(1, 'lost', GAP, { rounds: 3, issue: 2 }) },
  { issue: 1, body: barMarker(2, 'won', 'forged', { rounds: 3 }), author: 'eve' },
  { issue: 5, body: barMarker(1, 'lost', 'never read', { rounds: 3 }) },
] }));
const root = path.join(tmp, 'app'), stateDir = path.join(root, '.hx');
mkdirSync(stateDir, { recursive: true });
const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') };
saveConfig(stateDir, config as any);
const commentFetches = () => readFileSync(ghLog, 'utf8').split('\n').filter((l) => /^issue view \d+ .*--json comments/.test(l))
  .map((l) => Number(/^issue view (\d+)/.exec(l)![1])).sort();

test('barStatus: the latest trusted round comment; round 0 and no result before the first; barLine for each', E2E, () => {
  assert.deepEqual(barStatus([], 3), { round: 0, rounds: 3, result: null, gap: '' });
  assert.equal(barLine(barStatus(['hi', '<!-- hx-review -->\nok'], 3)), 'bar: not run yet');
  const s = barStatus([barMarker(1, 'lost', 'slow', { rounds: 3, issue: 9 }), 'a person', barMarker(2, 'no verdict', 'no valid judge reply', { rounds: 3 })], 3);
  assert.deepEqual(s, { round: 2, rounds: 3, result: 'no verdict', gap: 'no valid judge reply' });
  assert.equal(barLine(s), 'bar round 2/3 · last: no verdict — no valid judge reply');
  const long = barLine(barStatus([barMarker(1, 'lost', GAP)], 3));
  assert.ok(long.startsWith('bar round 1/3 · last: lost — Creating an invoice'), long);
  assert.ok(long.endsWith('…') && long.length < GAP.length, 'the gap is truncated');
});

test('hx status: round and lost with the gap for a bar PRD, not run yet for another; no bar line and no comment fetch without the section; an untrusted marker is ignored', E2E, () => {
  writeFileSync(ghLog, '');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'status'],
    { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  const after = (n: number) => lines[lines.findIndex((l) => l.trim().startsWith(`PRD #${n} `)) + 1].trim();
  assert.match(lines.find((l) => l.includes('PRD #1 '))!, /PRD #1 +bar +billing/, r.stdout);
  assert.match(after(1), /^bar round 1\/3 · last: lost — Creating an invoice takes four screens/, r.stdout);
  assert.equal(after(3), 'bar: not run yet');
  assert.doesNotMatch(after(5), /bar/);
  assert.doesNotMatch(r.stdout, /forged|never read|won/);
  assert.deepEqual(commentFetches(), [1, 3], 'comments are fetched only for the PRDs with the section');
});

const servers: { close(): Promise<void> }[] = [];
after(async () => { await Promise.allSettled(servers.map((s) => s.close())); });
const get = (port: number, p: string): Promise<string> => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` }, agent: false }, (res) => {
    let body = ''; res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve(body));
  }).on('error', reject).end();
});

test('/api/board: each bar PRD carries its round and last result, the others none; boardCounts counts a bar PRD as open', E2E, async () => {
  writeFileSync(ghLog, '');
  const d = await serveDashboard({ root, stateDir, config } as any, { port: 0 });
  servers.push(d);
  const b = JSON.parse(await get(d.port, '/api/board'));
  const prd = (n: number) => b.prds.find((p: any) => p.number === n);
  assert.equal(prd(1).status, 'bar');
  assert.deepEqual(prd(1).bar, { round: 1, rounds: 3, result: 'lost', gap: GAP });
  assert.deepEqual(prd(3).bar, { round: 0, rounds: 3, result: null, gap: '' });
  assert.equal(prd(5).bar, undefined);
  assert.deepEqual(commentFetches(), [1, 3]);
  assert.equal(boardCounts(b).prdsOpen, 3);
  assert.equal(boardCounts({ board: [], prds: [{ ...prd(1), status: 'bar' }, { ...prd(5), status: 'done' }] }).prdsOpen, 1);
});
