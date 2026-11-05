// The day, week and project reports: layout, ordering, totals, empty ranges and a running entry.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, readLog, tally, tmpLog } from './helpers.mjs';

const logOf = (...lines) => tmpLog(lines.map((l) => l + '\n').join(''));

const ok = (r, out) => {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.out, out);
};

const failsWith = (r, code) => {
  assert.equal(r.code, code, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.stdout, '', 'errors go to stderr only');
  assert.notEqual(r.stderr.trim(), '', 'an error message on stderr');
};

// the cases run side by side: each has its own temp log
describe('reports', { concurrency: true }, () => {
  test('day report: the date, one row per project by name, then the total', async () => {
    const log = logOf('2024-03-04T13:00 2024-03-04T13:30 beta', '2024-03-04T09:00 2024-03-04T10:15 acme fixed the login bug');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-04T18:00', log }), '2024-03-04\nacme 1:15\nbeta 0:30\ntotal 1:45');
  });

  test('day report: without a date it is the day of now', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-05T09:00 2024-03-05T09:30 beta');
    ok(await tally(['report', 'day'], { now: '2024-03-05T18:00', log }), '2024-03-05\nbeta 0:30\ntotal 0:30');
  });

  test('day report: entries on other days are left out', async () => {
    const log = logOf('2024-03-03T09:00 2024-03-03T10:00 acme', '2024-03-04T09:00 2024-03-04T09:45 beta', '2024-03-05T09:00 2024-03-05T10:00 acme');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-06T09:00', log }), '2024-03-04\nbeta 0:45\ntotal 0:45');
  });

  test('day report: the entries of one project add up into one row', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T09:40 acme', '2024-03-04T10:00 2024-03-04T10:20 beta', '2024-03-04T11:00 2024-03-04T11:35 acme');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-04T18:00', log }), '2024-03-04\nacme 1:15\nbeta 0:15\ntotal 1:30');
  });

  test('day report: an entry across midnight counts on each day for its part', async () => {
    const log = logOf('2024-03-04T23:00 2024-03-05T01:30 acme');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-06T09:00', log }), '2024-03-04\nacme 1:00\ntotal 1:00');
    ok(await tally(['report', 'day', '2024-03-05'], { now: '2024-03-06T09:00', log }), '2024-03-05\nacme 1:30\ntotal 1:30');
  });

  test('day report: a day with no time is the date and total 0:00', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme');
    ok(await tally(['report', 'day', '2024-03-09'], { now: '2024-03-09T09:00', log }), '2024-03-09\ntotal 0:00');
  });

  test('day report: with no log yet it is the date and total 0:00', async () => {
    ok(await tally(['report', 'day'], { now: '2024-03-04T09:00' }), '2024-03-04\ntotal 0:00');
  });

  test('day report: a running entry counts up to now', async () => {
    const log = logOf('2024-03-04T08:00 2024-03-04T08:30 beta', '2024-03-04T09:00 - acme');
    ok(await tally(['report', 'day'], { now: '2024-03-04T10:30', log }), '2024-03-04\nacme 1:30\nbeta 0:30\ntotal 2:00');
  });

  test('day report: a running entry started the day before counts from midnight on today', async () => {
    const log = logOf('2024-03-04T22:00 - acme');
    ok(await tally(['report', 'day'], { now: '2024-03-05T01:00', log }), '2024-03-05\nacme 1:00\ntotal 1:00');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-05T01:00', log }), '2024-03-04\nacme 2:00\ntotal 2:00');
  });

  test('day report: a row that rounds to 0:00 is still shown', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T09:05 acme', '2024-03-04T10:00 2024-03-04T11:00 beta');
    ok(await tally(['report', 'day', '2024-03-04'], { now: '2024-03-04T18:00', log }), '2024-03-04\nacme 0:00\nbeta 1:00\ntotal 1:00');
  });

  test('day report: a bad date is exit 1', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme');
    for (const d of ['2024-02-30', '04-03-2024', '2024-03-04T09:00']) {
      failsWith(await tally(['report', 'day', d], { log }), 1);
    }
  });

  test('day report: does not change the log', async () => {
    const text = '2024-03-04T09:00   2024-03-04T10:00 acme\n# hand edited\n2024-03-04T11:00 - beta';
    const log = tmpLog(text);
    await tally(['report', 'day'], { now: '2024-03-04T12:00', log });
    assert.equal(readLog(log), text);
  });

  test('day report: dayReport gives the date, the rows in printed order with rounded minutes, and the total', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog('2024-03-04T13:00 2024-03-04T13:30 beta\n2024-03-04T09:00 2024-03-04T10:08 acme\n2024-03-05T09:00 2024-03-05T10:00 acme\n');
    assert.deepEqual(lib.dayReport(entries, '2024-03-04', '2024-03-05T12:00'), {
      date: '2024-03-04', rows: [{ project: 'acme', minutes: 75 }, { project: 'beta', minutes: 30 }], total: 105,
    });
  });

  test('day report: dayReport of a day with no time has no rows and a total of 0', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog('2024-03-04T09:00 2024-03-04T10:00 acme\n');
    assert.deepEqual(lib.dayReport(entries, '2024-03-07', '2024-03-07T12:00'), { date: '2024-03-07', rows: [], total: 0 });
  });

  test('week report: week of the Monday, one row per day by date, then the total', async () => {
    const log = logOf('2024-03-06T09:00 2024-03-06T09:15 acme', '2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T13:00 2024-03-04T13:45 beta');
    ok(await tally(['report', 'week', '2024-03-06'], { now: '2024-03-08T09:00', log }), 'week of 2024-03-04\n2024-03-04 1:45\n2024-03-06 0:15\ntotal 2:00');
  });

  test('week report: without a date it is the week of now', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-12T09:00 2024-03-12T09:30 beta');
    ok(await tally(['report', 'week'], { now: '2024-03-14T18:00', log }), 'week of 2024-03-11\n2024-03-12 0:30\ntotal 0:30');
  });

  test('week report: a Sunday belongs to the week of the Monday before it', async () => {
    const log = logOf('2024-03-10T09:00 2024-03-10T10:00 acme', '2024-03-11T09:00 2024-03-11T10:00 acme');
    ok(await tally(['report', 'week', '2024-03-10'], { now: '2024-03-12T09:00', log }), 'week of 2024-03-04\n2024-03-10 1:00\ntotal 1:00');
  });

  test('week report: a Monday starts its own week, the Sunday before is left out', async () => {
    const log = logOf('2024-03-03T09:00 2024-03-03T10:00 acme', '2024-03-04T09:00 2024-03-04T09:30 acme');
    ok(await tally(['report', 'week', '2024-03-04'], { now: '2024-03-05T09:00', log }), 'week of 2024-03-04\n2024-03-04 0:30\ntotal 0:30');
  });

  test('week report: a week across a month and a year starts on its Monday', async () => {
    const log = logOf('2024-12-31T09:00 2024-12-31T10:00 acme', '2025-01-02T09:00 2025-01-02T09:45 beta');
    ok(await tally(['report', 'week', '2025-01-01'], { now: '2025-01-03T09:00', log }), 'week of 2024-12-30\n2024-12-31 1:00\n2025-01-02 0:45\ntotal 1:45');
  });

  test('week report: a week with no time is the header and total 0:00', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme');
    ok(await tally(['report', 'week', '2024-03-20'], { now: '2024-03-20T09:00', log }), 'week of 2024-03-18\ntotal 0:00');
  });

  test('week report: a day row adds up every project of that day', async () => {
    const log = logOf('2024-03-05T09:00 2024-03-05T09:40 acme', '2024-03-05T10:00 2024-03-05T10:35 beta');
    ok(await tally(['report', 'week', '2024-03-05'], { now: '2024-03-06T09:00', log }), 'week of 2024-03-04\n2024-03-05 1:15\ntotal 1:15');
  });

  test('week report: an entry across midnight counts on each day for its part', async () => {
    const log = logOf('2024-03-05T23:00 2024-03-06T00:30 acme');
    ok(await tally(['report', 'week', '2024-03-05'], { now: '2024-03-08T09:00', log }), 'week of 2024-03-04\n2024-03-05 1:00\n2024-03-06 0:30\ntotal 1:30');
  });

  test('week report: an entry from Sunday night into Monday counts only its Sunday part in the earlier week', async () => {
    const log = logOf('2024-03-10T23:00 2024-03-11T02:00 acme');
    ok(await tally(['report', 'week', '2024-03-04'], { now: '2024-03-12T09:00', log }), 'week of 2024-03-04\n2024-03-10 1:00\ntotal 1:00');
    ok(await tally(['report', 'week', '2024-03-11'], { now: '2024-03-12T09:00', log }), 'week of 2024-03-11\n2024-03-11 2:00\ntotal 2:00');
  });

  test('week report: a running entry counts up to now', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 beta', '2024-03-06T08:00 - acme');
    ok(await tally(['report', 'week'], { now: '2024-03-06T10:15', log }), 'week of 2024-03-04\n2024-03-04 1:00\n2024-03-06 2:15\ntotal 3:15');
  });

  test('week report: a bad date is exit 1', async () => {
    failsWith(await tally(['report', 'week', '2024-13-01'], { log: logOf('2024-03-04T09:00 2024-03-04T10:00 acme') }), 1);
  });

  test('week report: weekReport gives the Monday, the day rows with rounded minutes, and the total', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog('2024-03-06T09:00 2024-03-06T09:22 acme\n2024-03-04T09:00 2024-03-04T10:00 acme\n2024-03-04T13:00 2024-03-04T13:38 beta\n');
    assert.deepEqual(lib.weekReport(entries, '2024-03-06', '2024-03-08T12:00'), {
      start: '2024-03-04', rows: [{ date: '2024-03-04', minutes: 105 }, { date: '2024-03-06', minutes: 15 }], total: 120,
    });
  });

  test('week report: weekReport of a week with no time has no rows and a total of 0', async () => {
    const lib = await loadLib();
    assert.deepEqual(lib.weekReport([], '2024-03-10', '2024-03-10T12:00'), { start: '2024-03-04', rows: [], total: 0 });
  });

  test('project report: one row per project by name, then the total', async () => {
    const log = logOf('2024-03-04T13:00 2024-03-04T16:15 beta', '2024-03-04T09:00 2024-03-04T12:00 acme', '2024-03-05T08:00 2024-03-05T17:30 acme');
    ok(await tally(['report', 'project'], { now: '2024-03-06T09:00', log }), 'acme 12:30\nbeta 3:15\ntotal 15:45');
  });

  test('project report: it covers all time, across days, months and years', async () => {
    const log = logOf('2023-12-31T09:00 2023-12-31T10:00 acme', '2024-02-29T09:00 2024-02-29T09:30 acme', '2024-03-04T09:00 2024-03-04T09:15 acme');
    ok(await tally(['report', 'project'], { now: '2024-03-06T09:00', log }), 'acme 1:45\ntotal 1:45');
  });

  test('project report: with no entries it is just total 0:00', async () => {
    ok(await tally(['report', 'project'], { log: tmpLog('# nothing yet\n\n') }), 'total 0:00');
  });

  test('project report: a running entry counts up to now', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T11:00 - acme');
    ok(await tally(['report', 'project'], { now: '2024-03-04T11:45', log }), 'acme 1:45\ntotal 1:45');
  });

  test('project report: project names sort by name, not by first use', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 zeta', '2024-03-04T10:00 2024-03-04T11:00 beta', '2024-03-04T11:00 2024-03-04T12:00 alpha');
    ok(await tally(['report', 'project'], { now: '2024-03-04T13:00', log }), 'alpha 1:00\nbeta 1:00\nzeta 1:00\ntotal 3:00');
  });

  test('project report: projectReport gives the rows in printed order with rounded minutes, and the total', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog('2024-03-04T13:00 2024-03-04T13:20 beta\n2024-03-04T09:00 2024-03-04T09:52 acme\n2024-03-05T09:00 - acme\n');
    assert.deepEqual(lib.projectReport(entries, '2024-03-05T10:00'), {
      rows: [{ project: 'acme', minutes: 105 }, { project: 'beta', minutes: 15 }], total: 120,
    });
  });

  test('project report: on a log with a wrong line it is exit 2 and stderr names the line', async () => {
    const r = await tally(['report', 'project'], { log: logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T11:00 2024-03-04T10:00 beta') });
    failsWith(r, 2);
    assert.match(r.stderr, /line 2\b/);
  });
});
