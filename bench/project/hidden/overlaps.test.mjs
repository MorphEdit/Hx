// Overlap detection, from the CLI (`tally overlaps`) and the library (`findOverlaps`).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, readLog, tally, tmpLog } from './helpers.mjs';

const text = (...lines) => lines.map((l) => l + '\n').join('');
const logOf = (...lines) => tmpLog(text(...lines));

const ok = (r, out) => {
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.equal(r.out, out);
};

// the cases run side by side: each has its own temp log
describe('overlaps', { concurrency: true }, () => {
  test('overlaps: none prints no overlaps', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T11:00 2024-03-04T12:00 beta');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'no overlaps');
  });

  test('overlaps: an empty log has no overlaps', async () => {
    ok(await tally(['overlaps']), 'no overlaps');
  });

  test('overlaps: adjacent entries, one ending as the next starts, do not overlap', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T10:00 2024-03-04T11:00 beta', '2024-03-04T08:00 2024-03-04T09:00 acme');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'no overlaps');
  });

  test('overlaps: two entries that overlap are one line, by line number', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T09:59 2024-03-04T11:00 beta');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'line 1 overlaps line 2');
  });

  test('overlaps: a nested entry overlaps the one around it', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T12:00 acme', '2024-03-04T10:00 2024-03-04T10:30 beta');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'line 1 overlaps line 2');
  });

  test('overlaps: two entries with the same times overlap', async () => {
    const log = logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T09:00 2024-03-04T10:00 acme');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'line 1 overlaps line 2');
  });

  test('overlaps: the smaller line number comes first, whichever entry starts first', async () => {
    const log = logOf('2024-03-04T10:00 2024-03-04T11:00 acme', '2024-03-04T09:00 2024-03-04T10:30 beta');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'line 1 overlaps line 2');
  });

  test('overlaps: line numbers count blank and comment lines', async () => {
    const log = tmpLog('# monday\n\n2024-03-04T09:00 2024-03-04T10:00 acme\n# after lunch\n2024-03-04T09:30 2024-03-04T10:30 beta\n');
    ok(await tally(['overlaps'], { now: '2024-03-04T13:00', log }), 'line 3 overlaps line 5');
  });

  test('overlaps: every overlapping pair, one per line, in order', async () => {
    const log = logOf(
      '2024-03-04T13:00 2024-03-04T14:00 delta',
      '2024-03-04T09:00 2024-03-04T11:00 acme',
      '2024-03-04T12:00 2024-03-04T12:30 gamma',
      '2024-03-04T10:00 2024-03-04T10:30 beta',
      '2024-03-04T10:15 2024-03-04T13:30 eps',
    );
    ok(await tally(['overlaps'], { now: '2024-03-04T15:00', log }),
      'line 1 overlaps line 5\nline 2 overlaps line 4\nline 2 overlaps line 5\nline 3 overlaps line 5\nline 4 overlaps line 5');
  });

  test('overlaps: entries across midnight overlap entries of the next day', async () => {
    const log = logOf('2024-03-04T23:00 2024-03-05T01:00 acme', '2024-03-05T00:30 2024-03-05T02:00 beta');
    ok(await tally(['overlaps'], { now: '2024-03-05T09:00', log }), 'line 1 overlaps line 2');
  });

  test('overlaps: a running entry runs up to now', async () => {
    const before = logOf('2024-03-04T09:00 2024-03-04T09:45 beta', '2024-03-04T09:30 - acme');
    ok(await tally(['overlaps'], { now: '2024-03-04T10:00', log: before }), 'line 1 overlaps line 2');
    // an entry after now is past the running entry's end
    const after = logOf('2024-03-04T09:00 - acme', '2024-03-04T10:00 2024-03-04T11:00 beta');
    ok(await tally(['overlaps'], { now: '2024-03-04T10:00', log: after }), 'no overlaps');
    ok(await tally(['overlaps'], { now: '2024-03-04T10:01', log: after }), 'line 1 overlaps line 2');
  });

  test('overlaps: does not change the log', async () => {
    const t = '2024-03-04T09:00  2024-03-04T10:00 acme\n2024-03-04T09:30\t2024-03-04T10:30 beta';
    const log = tmpLog(t);
    await tally(['overlaps'], { now: '2024-03-04T13:00', log });
    assert.equal(readLog(log), t);
  });

  test('overlaps: on a log with a wrong line it is exit 2 and stderr names the line', async () => {
    const r = await tally(['overlaps'], { log: logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '', 'not a line') });
    assert.equal(r.code, 2, `exit ${r.code}, stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /line 3\b/);
  });

  test('overlaps: findOverlaps of adjacent, nested and overlapping entries', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog(text(
      '2024-03-04T09:00 2024-03-04T10:00 acme',
      '2024-03-04T10:00 2024-03-04T12:00 beta',
      '2024-03-04T10:30 2024-03-04T11:00 gamma',
      '2024-03-04T11:45 2024-03-04T12:15 delta',
    ));
    assert.deepEqual(lib.findOverlaps(entries, '2024-03-04T13:00'), [[2, 3], [2, 4]]);
  });

  test('overlaps: findOverlaps of no overlaps is an empty list', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog(text('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T10:00 2024-03-04T11:00 acme'));
    assert.deepEqual(lib.findOverlaps(entries, '2024-03-04T13:00'), []);
    assert.deepEqual(lib.findOverlaps([], '2024-03-04T13:00'), []);
  });

  test('overlaps: findOverlaps puts the smaller line first and the pairs in order', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog(text(
      '2024-03-04T11:00 2024-03-04T12:00 acme',
      '2024-03-04T09:00 2024-03-04T10:00 beta',
      '2024-03-04T09:30 2024-03-04T11:30 gamma',
    ));
    assert.deepEqual(lib.findOverlaps(entries, '2024-03-04T13:00'), [[1, 3], [2, 3]]);
  });

  test('overlaps: findOverlaps runs a running entry up to now', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog(text('2024-03-04T10:00 2024-03-04T11:00 beta', '2024-03-04T09:00 - acme'));
    assert.deepEqual(lib.findOverlaps(entries, '2024-03-04T10:00'), []);
    assert.deepEqual(lib.findOverlaps(entries, '2024-03-04T10:30'), [[1, 2]]);
  });
});
