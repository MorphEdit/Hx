// start / stop / status / add from the command line.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readLog, tally, tmpLog } from './helpers.mjs';

// the cases run side by side: each has its own temp log
describe('start, stop, status and add', { concurrency: true }, () => {
  const failsWith = (r, code) => {
    assert.equal(r.code, code, `exit ${r.code}, stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'errors go to stderr only');
    assert.notEqual(r.stderr.trim(), '', 'an error message on stderr');
  };

  test('start prints the project and the time it started', async () => {
    const r = await tally(['start', 'acme'], { now: '2024-03-04T09:15' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'started acme at 2024-03-04T09:15');
  });

  test('start writes a running entry to the log', async () => {
    const log = tmpLog();
    await tally(['start', 'acme'], { now: '2024-03-04T09:15', log });
    assert.equal(readLog(log), '2024-03-04T09:15 - acme\n');
  });

  test('start takes every word after the project as the note', async () => {
    const log = tmpLog();
    const r = await tally(['start', 'acme', 'fix', 'the', 'login'], { now: '2024-03-04T09:15', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLog(log), '2024-03-04T09:15 - acme fix the login\n');
  });

  test('start takes a quoted note as it is', async () => {
    const log = tmpLog();
    await tally(['start', 'acme', 'review, then merge'], { now: '2024-03-04T09:15', log });
    assert.equal(readLog(log), '2024-03-04T09:15 - acme review, then merge\n');
  });

  test('start accepts a project name with digits, dots, dashes and underscores', async () => {
    const log = tmpLog();
    const r = await tally(['start', 'client-2.web_x'], { now: '2024-03-04T09:15', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLog(log), '2024-03-04T09:15 - client-2.web_x\n');
  });

  test('start when something is already running: exit 1, the message names the running project', async () => {
    const log = tmpLog('2024-03-04T08:00 - beta\n');
    const r = await tally(['start', 'acme'], { now: '2024-03-04T09:15', log });
    failsWith(r, 1);
    assert.match(r.stderr, /beta/);
    assert.equal(readLog(log), '2024-03-04T08:00 - beta\n', 'the log is untouched');
  });

  test('start without a project is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['start'], { log }), 1);
    assert.equal(readLog(log), '');
  });

  test('start with an invalid project name is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['start', '-acme'], { log }), 1);
    failsWith(await tally(['start', 'acme/web'], { log }), 1);
    assert.equal(readLog(log), '');
  });

  test('start appends after the entries already in the log', async () => {
    const log = tmpLog('2024-03-04T08:00 2024-03-04T09:00 beta\n');
    await tally(['start', 'acme'], { now: '2024-03-04T09:15', log });
    assert.equal(readLog(log), '2024-03-04T08:00 2024-03-04T09:00 beta\n2024-03-04T09:15 - acme\n');
  });

  test('start adds the missing newline before appending', async () => {
    const log = tmpLog('2024-03-04T08:00 2024-03-04T09:00 beta');
    await tally(['start', 'acme'], { now: '2024-03-04T09:15', log });
    assert.equal(readLog(log), '2024-03-04T08:00 2024-03-04T09:00 beta\n2024-03-04T09:15 - acme\n');
  });

  test('stop prints the project, the end and the duration', async () => {
    const log = tmpLog('2024-03-04T09:15 - acme\n');
    const r = await tally(['stop'], { now: '2024-03-04T10:30', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'stopped acme at 2024-03-04T10:30 (1:15)');
  });

  test('stop writes the end time into the running entry, keeping its note', async () => {
    const log = tmpLog('2024-03-04T09:15 - acme fix the login\n');
    await tally(['stop'], { now: '2024-03-04T10:30', log });
    assert.equal(readLog(log), '2024-03-04T09:15 2024-03-04T10:30 acme fix the login\n');
  });

  test('stop rewrites only the running line, in place', async () => {
    const log = tmpLog('# my week\n2024-03-04T07:00 2024-03-04T08:00   beta   early\n\n2024-03-04T09:15 - acme\n2024-03-03T10:00 2024-03-03T11:00 old\n');
    await tally(['stop'], { now: '2024-03-04T10:30', log });
    assert.equal(readLog(log), '# my week\n2024-03-04T07:00 2024-03-04T08:00   beta   early\n\n'
      + '2024-03-04T09:15 2024-03-04T10:30 acme\n2024-03-03T10:00 2024-03-03T11:00 old\n');
  });

  test('stop counts an entry across midnight', async () => {
    const log = tmpLog('2024-03-04T23:30 - acme\n');
    const r = await tally(['stop'], { now: '2024-03-05T01:05', log });
    assert.equal(r.out, 'stopped acme at 2024-03-05T01:05 (1:35)');
  });

  test('stop shows ten hours and more as h:mm', async () => {
    const log = tmpLog('2024-03-04T08:00 - acme\n');
    assert.equal((await tally(['stop'], { now: '2024-03-04T18:00', log })).out, 'stopped acme at 2024-03-04T18:00 (10:00)');
  });

  test('stop when nothing is running is exit 1', async () => {
    const log = tmpLog('2024-03-04T08:00 2024-03-04T09:00 beta\n');
    failsWith(await tally(['stop'], { now: '2024-03-04T10:00', log }), 1);
    assert.equal(readLog(log), '2024-03-04T08:00 2024-03-04T09:00 beta\n');
  });

  test('stop on a log that does not exist is exit 1', async () => {
    failsWith(await tally(['stop'], { log: tmpLog() }), 1);
  });

  test('stop when now is not after the start is exit 1', async () => {
    const log = tmpLog('2024-03-04T09:15 - acme\n');
    failsWith(await tally(['stop'], { now: '2024-03-04T09:15', log }), 1);
    failsWith(await tally(['stop'], { now: '2024-03-04T09:00', log }), 1);
    assert.equal(readLog(log), '2024-03-04T09:15 - acme\n');
  });

  test('status shows the running project and the time so far, not rounded', async () => {
    const log = tmpLog('2024-03-04T09:15 - acme\n');
    const r = await tally(['status'], { now: '2024-03-04T10:22', log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'acme running since 2024-03-04T09:15 (1:07)');
  });

  test('status when nothing is running', async () => {
    const r = await tally(['status'], { log: tmpLog('2024-03-04T08:00 2024-03-04T09:00 beta\n') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'not running');
  });

  test('status with no log yet', async () => {
    const r = await tally(['status'], { log: tmpLog() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'not running');
  });

  test('start then status then stop then status', async () => {
    const log = tmpLog();
    await tally(['start', 'acme', 'standup'], { now: '2024-03-04T09:00', log });
    assert.equal((await tally(['status'], { now: '2024-03-04T09:20', log })).out, 'acme running since 2024-03-04T09:00 (0:20)');
    assert.equal((await tally(['stop'], { now: '2024-03-04T09:30', log })).out, 'stopped acme at 2024-03-04T09:30 (0:30)');
    assert.equal((await tally(['status'], { now: '2024-03-04T09:40', log })).out, 'not running');
    assert.equal(readLog(log), '2024-03-04T09:00 2024-03-04T09:30 acme standup\n');
  });

  test('add prints the entry and its duration', async () => {
    const r = await tally(['add', 'acme', '2024-03-04T09:00', '2024-03-04T10:00', 'standup'], { log: tmpLog() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out, 'added acme 2024-03-04T09:00 to 2024-03-04T10:00 (1:00)');
  });

  test('add appends a finished entry with its note', async () => {
    const log = tmpLog('2024-03-04T08:00 2024-03-04T09:00 beta\n');
    await tally(['add', 'acme', '2024-03-04T09:00', '2024-03-04T10:00', 'standup', 'and', 'planning'], { log });
    assert.equal(readLog(log), '2024-03-04T08:00 2024-03-04T09:00 beta\n2024-03-04T09:00 2024-03-04T10:00 acme standup and planning\n');
  });

  test('add without a note writes no trailing space', async () => {
    const log = tmpLog();
    await tally(['add', 'acme', '2024-03-04T09:00', '2024-03-04T09:45'], { log });
    assert.equal(readLog(log), '2024-03-04T09:00 2024-03-04T09:45 acme\n');
  });

  test('add works while an entry is running', async () => {
    const log = tmpLog('2024-03-04T09:00 - beta\n');
    const r = await tally(['add', 'acme', '2024-03-03T09:00', '2024-03-03T09:45'], { log });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await tally(['status'], { now: '2024-03-04T09:30', log })).out, 'beta running since 2024-03-04T09:00 (0:30)');
  });

  test('add with a malformed time is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['add', 'acme', '2024-03-04 09:00', '2024-03-04T10:00'], { log }), 1);
    failsWith(await tally(['add', 'acme', '2024-03-04T09:00', '10:00'], { log }), 1);
    assert.equal(readLog(log), '');
  });

  test('add with an impossible date or time is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['add', 'acme', '2024-02-30T09:00', '2024-02-30T10:00'], { log }), 1);
    failsWith(await tally(['add', 'acme', '2024-03-04T23:00', '2024-03-04T24:00'], { log }), 1);
    assert.equal(readLog(log), '');
  });

  test('add with the end not after the start is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['add', 'acme', '2024-03-04T10:00', '2024-03-04T09:00'], { log }), 1);
    failsWith(await tally(['add', 'acme', '2024-03-04T10:00', '2024-03-04T10:00'], { log }), 1);
    assert.equal(readLog(log), '');
  });

  test('add with missing arguments is exit 1', async () => {
    failsWith(await tally(['add', 'acme', '2024-03-04T10:00'], { log: tmpLog() }), 1);
  });

  test('an unknown command is exit 1', async () => {
    failsWith(await tally(['frobnicate'], { log: tmpLog() }), 1);
  });

  test('a malformed TALLY_NOW is exit 1', async () => {
    const log = tmpLog();
    failsWith(await tally(['start', 'acme'], { now: 'tomorrow', log }), 1);
    assert.equal(readLog(log), '');
  });
});
