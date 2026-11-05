// The log line format, as tally writes it and reads it, hand-edited logs included.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, readLog, tally, tmpLog } from './helpers.mjs';

// the cases run side by side: each has its own temp log
describe('the log format', { concurrency: true }, () => {
  test('parseLog reads a finished entry with a note', async () => {
    const lib = await loadLib();
    assert.deepEqual(lib.parseLog('2024-03-04T09:00 2024-03-04T10:15 acme fixed the login bug\n'), [
      { line: 1, project: 'acme', start: '2024-03-04T09:00', end: '2024-03-04T10:15', note: 'fixed the login bug' },
    ]);
  });

  test('parseLog reads a running entry: end null, note empty', async () => {
    const lib = await loadLib();
    assert.deepEqual(lib.parseLog('2024-03-04T13:00 - beta\n'), [
      { line: 1, project: 'beta', start: '2024-03-04T13:00', end: null, note: '' },
    ]);
  });

  test('parseLog of an empty text is no entries', async () => {
    const lib = await loadLib();
    assert.deepEqual(lib.parseLog(''), []);
  });

  test('parseLog keeps file order and counts blank and comment lines in line numbers', async () => {
    const lib = await loadLib();
    const text = '# March\n\n2024-03-05T09:00 2024-03-05T10:00 beta\n# done\n2024-03-04T09:00 2024-03-04T10:00 acme\n';
    assert.deepEqual(lib.parseLog(text).map((e) => [e.line, e.project]), [[3, 'beta'], [5, 'acme']]);
  });

  test('parseLog reads several spaces and tabs between fields', async () => {
    const lib = await loadLib();
    const [e] = lib.parseLog('2024-03-04T09:00  \t2024-03-04T10:15\t\tacme   standup\n');
    assert.deepEqual([e.start, e.end, e.project, e.note], ['2024-03-04T09:00', '2024-03-04T10:15', 'acme', 'standup']);
  });

  test('parseLog reads CRLF line endings', async () => {
    const lib = await loadLib();
    const entries = lib.parseLog('2024-03-04T09:00 2024-03-04T10:00 acme standup\r\n2024-03-04T11:00 - beta\r\n');
    assert.deepEqual(entries.map((e) => [e.line, e.project, e.end, e.note]), [[1, 'acme', '2024-03-04T10:00', 'standup'], [2, 'beta', null, '']]);
  });

  test('parseLog reads a last line with no newline', async () => {
    const lib = await loadLib();
    assert.equal(lib.parseLog('2024-03-04T09:00 2024-03-04T10:00 acme').length, 1);
  });

  test('formatEntry writes single spaces, the note last', async () => {
    const lib = await loadLib();
    assert.equal(lib.formatEntry({ line: 1, project: 'acme', start: '2024-03-04T09:00', end: '2024-03-04T10:15', note: 'fixed the login bug' }),
      '2024-03-04T09:00 2024-03-04T10:15 acme fixed the login bug');
  });

  test('formatEntry writes a running entry with - and no trailing space', async () => {
    const lib = await loadLib();
    assert.equal(lib.formatEntry({ line: 1, project: 'beta', start: '2024-03-04T13:00', end: null, note: '' }), '2024-03-04T13:00 - beta');
  });

  test('formatEntry of a parsed hand-edited line is the normalised line', async () => {
    const lib = await loadLib();
    const [e] = lib.parseLog('2024-03-04T09:00\t2024-03-04T10:15    acme   fixed it   \n');
    assert.equal(lib.formatEntry(e), '2024-03-04T09:00 2024-03-04T10:15 acme fixed it');
  });

  test('what the CLI writes, parseLog reads back', async () => {
    const lib = await loadLib();
    const log = tmpLog();
    await tally(['add', 'acme', '2024-03-04T09:00', '2024-03-04T10:00', 'review, "then" merge'], { log });
    await tally(['start', 'beta'], { now: '2024-03-04T11:00', log });
    assert.deepEqual(lib.parseLog(readLog(log)), [
      { line: 1, project: 'acme', start: '2024-03-04T09:00', end: '2024-03-04T10:00', note: 'review, "then" merge' },
      { line: 2, project: 'beta', start: '2024-03-04T11:00', end: null, note: '' },
    ]);
  });

  test('the CLI reads a hand-edited log with comments, blank lines, tabs and CRLF', async () => {
    const log = tmpLog('# hours for March\r\n\r\n2024-03-04T07:00\t2024-03-04T08:00   beta   early\r\n2024-03-04T09:15 -  acme\r\n');
    const r = await tally(['status'], { now: '2024-03-04T09:45', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'acme running since 2024-03-04T09:15 (0:30)');
  });

  test('stop leaves hand-edited lines as they are', async () => {
    const before = '# hours\n2024-03-04T07:00\t2024-03-04T08:00   beta   early\n\n2024-03-04T09:15 - acme\n';
    const log = tmpLog(before);
    const r = await tally(['stop'], { now: '2024-03-04T09:45', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLog(log), '# hours\n2024-03-04T07:00\t2024-03-04T08:00   beta   early\n\n2024-03-04T09:15 2024-03-04T09:45 acme\n');
  });

  test('add leaves hand-edited lines as they are and appends', async () => {
    const before = '# hours\n2024-03-04T07:00   2024-03-04T08:00 beta';
    const log = tmpLog(before);
    await tally(['add', 'acme', '2024-03-04T09:00', '2024-03-04T10:00'], { log });
    assert.equal(readLog(log), before + '\n2024-03-04T09:00 2024-03-04T10:00 acme\n');
  });

  test('a note may hold several words and punctuation', async () => {
    const lib = await loadLib();
    const [e] = lib.parseLog('2024-03-04T09:00 2024-03-04T10:00 acme call w/ Bob: plan, "v2" #3\n');
    assert.equal(e.note, 'call w/ Bob: plan, "v2" #3');
  });

  test('the log location comes from TALLY_LOG, so two logs stay apart', async () => {
    const a = tmpLog();
    const b = tmpLog();
    await tally(['start', 'acme'], { now: '2024-03-04T09:00', log: a });
    assert.equal((await tally(['status'], { log: b })).out, 'not running');
    assert.equal(readLog(b), '');
    assert.equal(readLog(a), '2024-03-04T09:00 - acme\n');
  });

  test('the duration of an entry and of a running entry up to now', async () => {
    const lib = await loadLib();
    const [done, running] = lib.parseLog('2024-03-04T09:00 2024-03-04T10:15 acme\n2024-03-04T23:50 - beta\n');
    assert.equal(lib.duration(done, '2024-03-05T00:20'), 75);
    assert.equal(lib.duration(running, '2024-03-05T00:20'), 30);
  });

  test('formatDuration is h:mm', async () => {
    const lib = await loadLib();
    assert.deepEqual([75, 600, 0, 5].map(lib.formatDuration), ['1:15', '10:00', '0:00', '0:05']);
  });
});
