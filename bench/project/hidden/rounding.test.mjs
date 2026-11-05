// The rounding rule: each report row to the nearest quarter hour, 7 minutes past a quarter or less down,
// 8 or more up; the total is the sum of the rounded rows. Values on, just below and just above each boundary.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, tally, tmpLog } from './helpers.mjs';

const logOf = (...lines) => tmpLog(lines.map((l) => l + '\n').join(''));

/** a finished entry on 2024-03-04 from 09:00, `minutes` long (under 15 hours) */
const lasting = (minutes, project = 'acme', day = '04') => {
  const end = 9 * 60 + minutes;
  const p = (n) => String(n).padStart(2, '0');
  return `2024-03-${day}T09:00 2024-03-${day}T${p(Math.floor(end / 60))}:${p(end % 60)} ${project}`;
};

const ok = (r, out) => {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.out, out);
};

// the cases run side by side: each has its own temp log
describe('rounding', { concurrency: true }, () => {
  test('rounding: whole quarter hours stay as they are', async () => {
    const lib = await loadLib();
    for (const m of [0, 15, 30, 45, 60, 75, 600]) assert.equal(lib.roundMinutes(m), m, `${m}`);
  });

  test('rounding: up to 7 minutes past a quarter rounds down', async () => {
    const lib = await loadLib();
    for (const [m, want] of [[1, 0], [5, 0], [7, 0], [16, 15], [22, 15], [37, 30], [52, 45], [67, 60], [607, 600]]) {
      assert.equal(lib.roundMinutes(m), want, `${m}`);
    }
  });

  test('rounding: 8 minutes past a quarter or more rounds up', async () => {
    const lib = await loadLib();
    for (const [m, want] of [[8, 15], [14, 15], [23, 30], [29, 30], [38, 45], [53, 60], [59, 60], [68, 75], [608, 615]]) {
      assert.equal(lib.roundMinutes(m), want, `${m}`);
    }
  });

  test('rounding: the examples of the brief, 1:07 to 1:00, 1:08 to 1:15, 0:05 to 0:00', async () => {
    const lib = await loadLib();
    assert.deepEqual([67, 68, 5].map((m) => lib.formatDuration(lib.roundMinutes(m))), ['1:00', '1:15', '0:00']);
  });

  test('rounding: a day report rounds each project on its own, just below and just above a boundary', async () => {
    const log = logOf(lasting(67, 'acme'), lasting(68, 'beta'), lasting(60, 'gamma'), lasting(7, 'delta'), lasting(8, 'eps'));
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-05T09:00', log }),
      '2024-03-04\nacme 1:00\nbeta 1:15\ndelta 0:00\neps 0:15\ngamma 1:00\ntotal 3:30');
  });

  test('rounding: the total is the sum of the rounded rows, not the rounded sum', async () => {
    // 7 + 7 = 14 minutes would round to 0:15; each row rounds to 0:00
    const log = logOf(lasting(7, 'acme'), lasting(7, 'beta'));
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-05T09:00', log }), '2024-03-04\nacme 0:00\nbeta 0:00\ntotal 0:00');
    ok(await tally(['report', 'project'], { now: '2024-03-05T09:00', log }), 'acme 0:00\nbeta 0:00\ntotal 0:00');
  });

  test('rounding: a week report rounds each day on its own', async () => {
    const log = logOf(lasting(22, 'acme', '04'), lasting(23, 'acme', '05'), lasting(52, 'acme', '06'), lasting(53, 'acme', '07'));
    ok(await tally(['report', 'week', '2024-03-04'], { now: '2024-03-09T09:00', log }),
      'week of 2024-03-04\n2024-03-04 0:15\n2024-03-05 0:30\n2024-03-06 0:45\n2024-03-07 1:00\ntotal 2:30');
  });

  test('rounding: a project report rounds the project total, not each entry', async () => {
    // 4 + 4 = 8 minutes rounds up, though each entry alone would round down
    const log = logOf(lasting(4, 'acme', '04'), lasting(4, 'acme', '05'), lasting(38, 'beta', '05'));
    ok(await tally(['report', 'project'], { now: '2024-03-06T09:00', log }), 'acme 0:15\nbeta 0:45\ntotal 1:00');
  });

  test('rounding: a running entry rounds its time so far in a report, while status shows it unrounded', async () => {
    const log = logOf('2024-03-04T09:00 - acme');
    ok(await tally(['report', 'day'], { now: '2024-03-04T10:08', log }), '2024-03-04\nacme 1:15\ntotal 1:15');
    ok(await tally(['status'], { now: '2024-03-04T10:08', log }), 'acme running since 2024-03-04T09:00 (1:08)');
  });

  test('rounding: stop and add show the exact duration', async () => {
    const log = logOf('2024-03-04T09:00 - acme');
    ok(await tally(['stop'], { now: '2024-03-04T09:07', log }), 'stopped acme at 2024-03-04T09:07 (0:07)');
    ok(await tally(['add', 'beta', '2024-03-04T10:00', '2024-03-04T11:08'], { log }), 'added beta 2024-03-04T10:00 to 2024-03-04T11:08 (1:08)');
  });

  test('rounding: report minutes from the library are rounded, durations are not', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog(lasting(53, 'acme') + '\n');
    assert.equal(lib.duration(entries[0], '2024-03-05T09:00'), 53);
    assert.deepEqual(lib.dayReport(entries, '2024-03-04', '2024-03-05T09:00').rows, [{ project: 'acme', minutes: 60 }]);
    assert.equal(lib.projectReport(entries, '2024-03-05T09:00').total, 60);
  });
});
