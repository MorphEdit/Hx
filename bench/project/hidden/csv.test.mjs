// CSV export, from the CLI (`tally csv`) and the library (`toCsv`): columns, header row, quoting.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, readLog, tally, tmpLog } from './helpers.mjs';

const HEADER = 'project,start,end,minutes,note\n';
const text = (...lines) => lines.map((l) => l + '\n').join('');
const logOf = (...lines) => tmpLog(text(...lines));

/** `tally csv` on a log of `lines`: exit 0, nothing on stderr, the stdout */
const csv = async (...lines) => {
  const r = await tally(['csv'], { now: '2024-03-06T09:00', log: logOf(...lines) });
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  return r.stdout.replace(/\r\n/g, '\n');
};

// the cases run side by side: each has its own temp log
describe('csv', { concurrency: true }, () => {
  test('csv: the header row, then one row per entry, as in the brief', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:15 acme fixed login, again', '2024-03-04T13:00 2024-03-04T13:20 beta'),
      HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:15,75,"fixed login, again"\nbeta,2024-03-04T13:00,2024-03-04T13:20,20,\n');
  });

  test('csv: an empty log is just the header row', async () => {
    const r = await tally(['csv']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), HEADER);
  });

  test('csv: rows keep log order, not time order', async () => {
    assert.equal(await csv('2024-03-05T09:00 2024-03-05T10:00 beta', '# comment', '', '2024-03-04T09:00 2024-03-04T10:00 acme'),
      HEADER + 'beta,2024-03-05T09:00,2024-03-05T10:00,60,\nacme,2024-03-04T09:00,2024-03-04T10:00,60,\n');
  });

  test('csv: the running entry is left out', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-05T08:00 - beta working on it'),
      HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,\n');
  });

  test('csv: only a running entry is just the header row', async () => {
    assert.equal(await csv('2024-03-05T08:00 - beta'), HEADER);
  });

  test('csv: minutes are the exact duration, unrounded, across midnight too', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T09:07 acme', '2024-03-04T22:50 2024-03-05T01:03 beta', '2024-03-04T00:00 2024-03-04T23:59 gamma'),
      HEADER + 'acme,2024-03-04T09:00,2024-03-04T09:07,7,\nbeta,2024-03-04T22:50,2024-03-05T01:03,133,\ngamma,2024-03-04T00:00,2024-03-04T23:59,1439,\n');
  });

  test('csv: a note with a comma is wrapped in double quotes', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:00 acme a, b, c'), HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,"a, b, c"\n');
  });

  test('csv: a note with a double quote is wrapped, the quote doubled', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:00 acme the "login" page'),
      HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,"the ""login"" page"\n');
  });

  test('csv: a note with commas and double quotes is wrapped once, every quote doubled', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:00 acme said "hi, there" and ""left""'),
      HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,"said ""hi, there"" and """"left"""""\n');
  });

  test('csv: a note with spaces and other punctuation is written as it is', async () => {
    assert.equal(await csv("2024-03-04T09:00 2024-03-04T10:00 acme fix; then (test) it's 100% done"),
      HEADER + "acme,2024-03-04T09:00,2024-03-04T10:00,60,fix; then (test) it's 100% done\n");
  });

  test('csv: project names are written as they are', async () => {
    assert.equal(await csv('2024-03-04T09:00 2024-03-04T10:00 client-2.web', '2024-03-04T10:00 2024-03-04T10:30 my_proj'),
      HEADER + 'client-2.web,2024-03-04T09:00,2024-03-04T10:00,60,\nmy_proj,2024-03-04T10:00,2024-03-04T10:30,30,\n');
  });

  test('csv: a hand-edited log gives the same rows as a tidy one', async () => {
    const r = await tally(['csv'], { log: tmpLog('# log\r\n\r\n2024-03-04T09:00\t2024-03-04T10:00   acme  standup, daily\r\n') });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,"standup, daily"\n');
  });

  test('csv: does not change the log', async () => {
    const t = '2024-03-04T09:00  2024-03-04T10:00 acme x, y\n2024-03-04T11:00 - beta';
    const log = tmpLog(t);
    await tally(['csv'], { log });
    assert.equal(readLog(log), t);
  });

  test('csv: on a log with a wrong line it is exit 2 and stderr names the line', async () => {
    const r = await tally(['csv'], { log: logOf('2024-03-04T09:00 2024-03-04T10:00 acme', '2024-03-04T09:00 2024-03-04T10:00 ,bad') });
    assert.equal(r.code, 2, `exit ${r.code}, stderr: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /line 2\b/);
  });

  test('csv: toCsv gives the same text as tally csv, every row ending in a newline', async () => {
    const lib = await loadLib();
    const t = text('2024-03-04T09:00 2024-03-04T10:15 acme fixed login, again', '2024-03-04T13:00 2024-03-04T13:20 beta', '2024-03-05T08:00 - acme');
    assert.equal(lib.toCsv(lib.parseLog(t)), HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:15,75,"fixed login, again"\nbeta,2024-03-04T13:00,2024-03-04T13:20,20,\n');
    const r = await tally(['csv'], { log: tmpLog(t) });
    assert.equal(r.stdout.replace(/\r\n/g, '\n'), lib.toCsv(lib.parseLog(t)));
  });

  test('csv: toCsv of no entries is the header row', async () => {
    const lib = await loadLib();
    assert.equal(lib.toCsv([]), HEADER);
  });

  test('csv: toCsv wraps a note with a line break in double quotes', async () => {
    const lib = await loadLib();
    const e = { line: 1, project: 'acme', start: '2024-03-04T09:00', end: '2024-03-04T10:00', note: 'first\nsecond' };
    assert.equal(lib.toCsv([e]), HEADER + 'acme,2024-03-04T09:00,2024-03-04T10:00,60,"first\nsecond"\n');
  });
});
