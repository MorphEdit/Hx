// The strict parse: every wrong line is an error naming its line number; the CLI exits 2 with it on stderr.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, readLog, tally, tmpLog } from './helpers.mjs';

// the cases run side by side: each has its own temp log
describe('parse errors', { concurrency: true }, () => {
  const OK = '2024-03-04T08:00 2024-03-04T09:00 beta\n';

  const wrong = {
    'too few fields': '2024-03-04T09:00 2024-03-04T10:00',
    'a malformed start': '2024-03-04 09:00 2024-03-04T10:00 acme',
    'a malformed end': '2024-03-04T09:00 10:00 acme',
    'a date that does not exist': '2024-02-30T09:00 2024-02-30T10:00 acme',
    'an hour of 24': '2024-03-04T23:00 2024-03-04T24:00 acme',
    'a minute of 60': '2024-03-04T09:00 2024-03-04T09:60 acme',
    'an invalid project name': '2024-03-04T09:00 2024-03-04T10:00 -acme',
    'the end before the start': '2024-03-04T10:00 2024-03-04T09:00 acme',
    'the end equal to the start': '2024-03-04T10:00 2024-03-04T10:00 acme',
  };

  for (const [what, line] of Object.entries(wrong)) {
    test(`parseLog throws on ${what}, naming the line`, async () => {
      const lib = await loadLib();
      const text = `# log\n${OK}\n${line}\n${OK}`;
      let err;
      try { lib.parseLog(text); } catch (e) { err = e; }
      assert.ok(err instanceof Error, 'an Error is thrown');
      assert.equal(err.line, 4);
      assert.match(err.message, /line 4\b/);
    });
  }

  test('parseLog throws on a second running entry, at the second one', async () => {
    const lib = await loadLib();
    let err;
    try { lib.parseLog('2024-03-04T09:00 - acme\n' + OK + '2024-03-04T11:00 - beta\n'); } catch (e) { err = e; }
    assert.equal(err?.line, 3);
    assert.match(err.message, /line 3\b/);
  });

  test('parseLog accepts 29 February in a leap year', async () => {
    const lib = await loadLib();
    assert.equal(lib.parseLog('2024-02-29T09:00 2024-02-29T10:00 acme\n').length, 1);
  });

  test('parseLog rejects 29 February in a common year', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseLog('2023-02-29T09:00 2023-02-29T10:00 acme\n'), (e) => e.line === 1);
  });

  test('the line number counts blank and comment lines', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseLog('\n# a\n\n# b\n\n\nnonsense\n'), (e) => e.line === 7 && /line 7\b/.test(e.message));
  });

  const cliCases = {
    status: ['status'],
    start: ['start', 'gamma'],
    stop: ['stop'],
    add: ['add', 'gamma', '2024-03-05T09:00', '2024-03-05T10:00'],
  };

  for (const [cmd, args] of Object.entries(cliCases)) {
    test(`${cmd} on a log with a wrong line: exit 2, stderr names the line, the log untouched`, async () => {
      const text = `${OK}# note\n2024-03-04T10:00 2024-03-04T09:00 acme\n2024-03-04T11:00 - delta\n`;
      const log = tmpLog(text);
      const r = await tally(args, { now: '2024-03-04T12:00', log });
      assert.equal(r.code, 2, `exit ${r.code}, stderr: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /line 3\b/);
      assert.equal(readLog(log), text);
    });
  }

  test('a second running entry in the log: exit 2, stderr names its line', async () => {
    const log = tmpLog('2024-03-04T09:00 - acme\n\n2024-03-04T10:00 - beta\n');
    const r = await tally(['status'], { now: '2024-03-04T12:00', log });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /line 3\b/);
  });

  test('a line with only a time: exit 2, stderr names the line', async () => {
    const log = tmpLog(OK + OK + '2024-03-04T10:00\n');
    const r = await tally(['status'], { log });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /line 3\b/);
  });

  test('the first wrong line is the one named', async () => {
    const log = tmpLog(OK + 'bad line here\n' + 'worse\n');
    const r = await tally(['status'], { log });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /line 2\b/);
  });
});
