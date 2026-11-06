// The design reference's SAMPLE (docs/design/control-room.html: the board, sessions and log of 2026-11-06 ~14:05), written
// once by hand in dashboardState's shape, for the control room's same-look test. Every time is built from a local Date, so
// the page shows the reference's clock times in any time zone.
const local = (h: number, m: number, s = 0) => new Date(2026, 10, 6, h, m, s);
const at = (h: number, m: number, s = 0) => local(h, m, s).toISOString();
const ms = (h: number, m: number) => local(h, m).getTime();

const ISSUE = ['Claimed', 'Implement', 'Audit', 'Merge', 'Gate'], PRD = ['Gauntlet', 'Decompose', 'Build', 'Review', 'Security'];
const STATE: Record<string, 'done' | 'now' | 'next'> = { d: 'done', n: 'now', x: 'next' };
const trail = (names: string[], states: string, notes: string[]) => names.map((name, i) => ({ name, state: STATE[states[i]], note: notes[i] ?? '' }));
const DONE = ['', 'done', 'done', 'merged ✓', 'done'];

type O = Record<string, unknown>;
const item = (number: number, prd: number | null, group: string, status: string, title: string, o: O = {}): O => ({
  number, prd, title, group, status, word: status, stage: null, since: null, waitsOn: [], worker: '—', tokens: '', time: '', round: '',
  pr: '', steps: trail(ISSUE, 'xxxxx', []), facts: [], next: '', board: null, held: false, closedAt: null, chip: null, ...o });
const done = (number: number, prd: number | null, group: string, title: string, worker: string, claimed: string,
  tokens: string, time: string, pr: string, closedAt: string, next: string) =>
  item(number, prd, group, 'done', title, { worker, tokens, time, round: '1 of 3', pr, closedAt, next,
    steps: trail(ISSUE, 'ddddd', [`${worker} · ${claimed}`, ...DONE.slice(1)]),
    facts: [['WORKER', worker], ['TOKENS', tokens], ['TIME', time], ['ROUND', '1 of 3'], ['PR', pr]] });
const waiting = (number: number, prd: number | null, group: string, title: string, on: string) =>
  item(number, prd, group, 'waiting', title, { board: 'waiting', waitsOn: [on], worker: 'none yet',
    facts: [['WAITS ON', on], ['WORKER', 'none yet']], next: `Starts when ${on} merges.` });
const closedPrd = (number: number, title: string, closed: [number, number], next: string) =>
  item(number, number, 'closed', 'done', title, { closedAt: at(...closed), board: 'done',
    steps: trail(PRD, 'ddddd', ['round 1 of 3 · PASS ✓', 'done', 'done', 'done', 'done']),
    facts: [['STATUS', `closed ${String(closed[0]).padStart(2, '0')}:${String(closed[1]).padStart(2, '0')}`], ['STEPS', 'all passed']], next });

const ITEMS = [
  item(348, 348, 'prd:348', 'implementing', 'Faster tests', { word: 'building', board: 'building',
    steps: trail(PRD, 'ddnxx', ['round 1 of 3 · PASS ✓', 'done', '2/6 issues done']), facts: [['STATUS', 'building'], ['STEPS', '2 of 5 done']],
    next: 'Its issues are being built: 2/6 done.' }),
  done(349, 348, 'prd:348', 'Run npm test through scripts/test.mjs, which caps parallel test files', 'W2', '10:51', '1.5M', '57 min', '#357', at(11, 48),
    'Merged. The cap is live: every session now runs tests inside its share of the CPU.'),
  done(350, 348, 'prd:348', 'Set HX_TEST_CONCURRENCY for every session, gate run and ship', 'W3', '09:30', '9.9M', '2h16m', '#358', at(11, 46),
    'Merged. hx status shows the concurrency in use (3 right now).'),
  item(351, 348, 'prd:348', 'merging', 'ship: record every full test run and skip --resume’s tests on a tree that already passed', {
    stage: 'merge', since: at(12, 36, 17), worker: 'W1', tokens: '4.4M', time: '1h29m', round: '1 of 3', pr: '#366', board: 'working',
    chip: { column: 'Merge', note: 'audit PASS · rebasing' },
    steps: trail(ISSUE, 'dddnx', ['W1 · 12:36', 'turn 1 ok · 2.5M tokens · 44 min', 'PASS ✓ · 1.9M tokens · 29 min', 'rebasing on main, then merging',
      'runs the full suite on main after the merge']),
    facts: [['WORKER', 'W1'], ['TOKENS', '4.4M'], ['TIME', '1h29m'], ['ROUND', '1 of 3'], ['PR', '#366']],
    next: 'Rebase on main and merge. When it lands, #352 can start.' }),
  item(354, 348, 'prd:348', 'implementing', 'Cut the slowest e2e tests: profile before and after, shrink waits and back-offs', {
    stage: 'impl', since: at(12, 37, 51), worker: 'W2', tokens: 'turn running', time: '1h27m', round: '1 of 3', pr: 'not yet', board: 'working',
    chip: { column: 'Implement', note: 'turn 1' },
    steps: trail(ISSUE, 'dnxxx', ['W2 · 12:37', 'turn running']),
    facts: [['WORKER', 'W2'], ['TOKENS', 'turn running'], ['TIME', '1h27m'], ['ROUND', '1 of 3'], ['PR', 'not yet']],
    next: 'The implementer is working on it (turn 1).' }),
  waiting(352, 348, 'prd:348', 'Gate: reuse a tree that passed in the last 2 h instead of re-running the suite', '#351'),
  waiting(353, 348, 'prd:348', 'hx usage --compare: gate runs reused and the median gate time', '#352'),
  item(362, null, 'split:325', 'implementing', 'Record a per-minute load history in .hx/load.jsonl during hx run', {
    stage: 'impl', since: at(12, 40, 26), worker: 'W3', tokens: 'turn running', time: '1h25m', round: '1 of 3', pr: 'not yet', board: 'working',
    chip: { column: 'Implement', note: 'turn 1' },
    steps: trail(ISSUE, 'dnxxx', ['W3 · 12:40', 'turn running']),
    facts: [['WORKER', 'W3'], ['TOKENS', 'turn running'], ['TIME', '1h25m'], ['ROUND', '1 of 3'], ['PR', 'not yet']],
    next: 'The implementer is working on it (turn 1). #363 waits for it.' }),
  waiting(363, null, 'split:325', 'The pure Machine analysis: use, throughput by worker count, slowdown, advice', '#362'),
  waiting(364, null, 'split:325', 'hx usage --machine [--days N]: the four Machine parts in the terminal', '#363'),
  waiting(365, null, 'split:325', 'The Machine panel in hx dashboard', '#363'),
  closedPrd(315, 'Auto-scale workers: claim new work only while the machine has room', [12, 37],
    'Closed. Workers now follow the CPU: 3 when there is room, fewer under load.'),
  closedPrd(300, 'An issue too big for one session is split, up front or after a timeout', [5, 31],
    'Closed. It already fired today: #325 was split into #362–#365 before it started.'),
  closedPrd(286, 'needs-human: hx asks you in plain words when a task truly needs a person', [4, 28],
    'Closed. Questions for you appear under Waiting on you.'),
  done(347, null, 'closed', 'A merge that fails after an audit PASS no longer uses up an audit round', 'W1', '08:20', '9.6M', '1h36m', '#355', at(9, 56), 'Merged.'),
  done(356, null, 'closed', 'Lighten the role-models e2e test so it fits its time limit on a loaded gate', 'W1', '09:29', '4.4M', '2h37m', '#361', at(12, 6, 12),
    'Merged. Main went green again at 6f53613.'),
];

const GROUPS = [
  { key: 'prd:348', title: 'PRD #348 · Faster tests', progress: '2/6' },
  { key: 'split:325', title: '#325 · Machine panel (split)', progress: '0/4' },
  { key: 'closed', title: 'Closed today', progress: '6' },
];

const bar = (issue: number | null, role: string, from: [number, number], to: [number, number], o: O = {}) =>
  ({ issue, role, startMs: ms(...from), endMs: ms(...to), ...o });
const TIMELINE = { from: ms(12, 30), to: ms(14, 10), lanes: [
  { worker: 'W1', bars: [bar(351, 'impl', [12, 36], [13, 20]), bar(351, 'audit', [13, 21], [13, 49]), bar(351, 'merge', [13, 50], [14, 5], { running: true })] },
  { worker: 'W2', bars: [bar(354, 'impl', [12, 38], [14, 5], { running: true })] },
  { worker: 'W3', bars: [bar(null, 'selfreview', [12, 38], [12, 40]), bar(362, 'impl', [12, 40], [14, 5], { running: true })] },
  { worker: 'gate', bars: [bar(null, 'gate', [12, 15], [12, 21], { ok: true })] },
] };

const ev = (t: [number, number, number], issue: number | null, step: string, text: string, tokens: number | null, kind: string) =>
  ({ t: at(...t), issue, step, text, tokens, kind });
const EVENTS = [
  ev([11, 32, 50], null, 'Gate', 'RED ✗ at 5ca3204: the role-models test hit its 10 min limit on a loaded machine', null, 'problem'),
  ev([12, 6, 12], 356, 'Merge', 'fix merged: the test now fits its limit', 4_400_000, 'result'),
  ev([12, 20, 41], null, 'Gate', 'green ✓ again at 6f53613', null, 'result'),
  ev([12, 21, 31], null, 'Start', 'restarted on the new code: auto-scale and test concurrency on', null, 'info'),
  ev([12, 36, 17], 351, 'Implement', 'claimed by W1', null, 'info'),
  ev([12, 37, 43], 315, 'Security', 'security pass DONE ✓', 288_000, 'result'),
  ev([12, 37, 49], 315, 'Close', 'PRD closed ✓', null, 'result'),
  ev([12, 37, 50], 325, 'Size', 'too big for one session: split into #362–#365 before starting', 97_000, 'info'),
  ev([12, 37, 51], 354, 'Implement', 'claimed by W2', null, 'info'),
  ev([12, 40, 16], 359, 'Close', 'closed without a PR: main was already green', 158_000, 'result'),
  ev([12, 40, 26], 362, 'Implement', 'claimed by W3', null, 'info'),
  ev([13, 20, 45], 351, 'Implement', 'turn 1 ok · 44 min', 2_500_000, 'info'),
  ev([13, 20, 55], 351, 'Audit', 'audit 1/3 on PR #366', null, 'info'),
  ev([13, 49, 41], 351, 'Audit', 'audit PASS ✓ · 29 min', 1_900_000, 'result'),
];

const session = (number: number, title: string, since: string) => ({ key: `issue:${number}`, number, kind: 'impl', title, since, turn: 1, tokens: 0 });

/** The sample as `/api/state` answers it: a fresh copy each call. */
export const controlRoomState = () => JSON.parse(JSON.stringify({
  repo: 'MorphEdit/Hx', waiting: [],
  runner: { running: true, pid: 4242, startedAt: at(12, 21, 31), uptimeMs: 104 * 60_000, workers: 3, draining: false,
    workersLine: 'workers 3/3 (auto: cpu 46%)', testConcurrency: 3, cpus: 12 },
  sessions: [session(351, ITEMS[3].title as string, at(12, 36, 17)), session(354, ITEMS[4].title as string, at(12, 37, 51)),
    session(362, ITEMS[7].title as string, at(12, 40, 26))],
  gate: { sha: '6f53613a9e0c4d2b1f8e7a6c5d4b3a2918070605', ok: true, at: at(12, 20, 41) },
  health: null, log: ['2026-11-06T12:21:31.000Z hx run: started'],
  usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null },
  timeline: TIMELINE, events: EVENTS, issues: { groups: GROUPS, items: ITEMS },
}));
