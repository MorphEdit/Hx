// The command line: usage errors (exit 1), the environment (exit 2), which error wins, and stdout versus stderr.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOK, fails, ledge, lines, ok, read, workdir } from './helpers.mjs';

const BAD_JOURNAL = lines('oops');

describe('the command line', { concurrency: true }, () => {
  test('no command is exit 1', async () => {
    fails(await ledge([]), 1);
  });

  test('an unknown command is exit 1', async () => {
    fails(await ledge(['balances']), 1);
  });

  test('an unknown option is exit 1', async () => {
    fails(await ledge(['balance', '--verbose', 'x']), 1);
  });

  test('a lone dash is an unknown option', async () => {
    fails(await ledge(['balance', '-']), 1);
  });

  test('an option the command does not take is exit 1', async () => {
    fails(await ledge(['check', '--account', 'Assets']), 1);
    fails(await ledge(['register', '--depth', '1']), 1);
    fails(await ledge(['print', '--sort', 'amount']), 1);
  });

  test('an option without its value is exit 1', async () => {
    fails(await ledge(['balance', '--from']), 1);
  });

  test('an option given twice is exit 1', async () => {
    fails(await ledge(['balance', '--from', '2024-01-01', '--from', '2024-01-02']), 1);
    fails(await ledge(['balance', '--sort', 'name', '--sort', 'name']), 1);
  });

  test('--account may be given twice for the filters', async () => {
    ok(await ledge(['balance', '--account', 'Assets:Cash', '--account', 'Equity'], { journal: BOOK }),
      'Assets:Cash -10.00 USD', 'Equity:Opening -1000.00 USD', 'total -1010.00 USD');
  });

  test('an option takes the next argument as its value, whatever it looks like', async () => {
    ok(await ledge(['register', '--payee', '--to'], { journal: BOOK }));
  });

  test('an extra argument is exit 1', async () => {
    fails(await ledge(['check', 'now']), 1);
    fails(await ledge(['balance', 'Assets']), 1);
    fails(await ledge(['report', 'month', 'year']), 1);
  });

  test('a malformed or unreal date in --from or --to is exit 1', async () => {
    fails(await ledge(['balance', '--from', '2024-1-01']), 1);
    fails(await ledge(['register', '--to', '2024-02-30']), 1);
  });

  test('--from after --to is exit 1', async () => {
    fails(await ledge(['balance', '--from', '2024-02-01', '--to', '2024-01-31']), 1);
  });

  test('a malformed --account or --currency is exit 1', async () => {
    fails(await ledge(['balance', '--account', 'assets']), 1);
    fails(await ledge(['balance', '--currency', 'usd']), 1);
  });

  test('a bad --depth or --sort is exit 1', async () => {
    for (const depth of ['0', '-1', 'two', '1.5', '+2']) fails(await ledge(['balance', '--depth', depth]), 1);
    fails(await ledge(['balance', '--sort', 'date']), 1);
    fails(await ledge(['register', '--sort', 'name']), 1);
  });

  test('report needs month, quarter or year', async () => {
    fails(await ledge(['report']), 1);
    fails(await ledge(['report', 'week']), 1);
  });

  test('a usage error wins over a bad LEDGE_TODAY and a bad journal', async () => {
    fails(await ledge(['balance', '--depth', '0'], { today: 'soon', journal: BAD_JOURNAL }), 1);
  });

  test('a malformed or unreal LEDGE_TODAY is exit 2, for every command', async () => {
    fails(await ledge(['check'], { today: '2024-3-15' }), 2);
    fails(await ledge(['accounts'], { today: '2023-02-29' }), 2);
    fails(await ledge(['balance'], { today: 'today' }), 2);
  });

  test('a bad LEDGE_TODAY wins over a bad journal', async () => {
    fails(await ledge(['check'], { today: '2024-03-32', journal: BAD_JOURNAL }), 2);
  });

  test('a missing file named on the command line wins over a bad journal', async () => {
    fails(await ledge(['import', 'nope.csv', '--account', 'Assets:Bank'], { journal: BAD_JOURNAL }), 2);
    fails(await ledge(['budget', '2024-01', '--budget', 'nope.budget'], { journal: BAD_JOURNAL }), 2);
  });

  test('a bad journal wins over a bad input file', async () => {
    const dir = workdir({ 'b.csv': 'nothing,useful\n' });
    fails(await ledge(['import', 'b.csv', '--account', 'Assets:Bank'], { dir, journal: BAD_JOURNAL }), 3);
  });

  test('without LEDGE_TODAY the local date is today', async () => {
    const dir = workdir();
    ok(await ledge(['account', 'Assets:Bank'], { dir, today: null }), 'declared Assets:Bank');
    ok(await ledge(['account', 'Equity:Opening'], { dir, today: null }), 'declared Equity:Opening');
    const r = await ledge(['add', 'today', 'Open', 'Assets:Bank', '1.00', 'USD', 'Equity:Opening'], { dir, today: null });
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // the run may cross midnight: either side of it is the local date
    const y = new Date(d.getTime() - 86_400_000);
    const before = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    assert.equal(r.code, 0, r.stderr);
    assert.ok([`added ${local} Open\n`, `added ${before} Open\n`].includes(r.stdout), r.stdout);
  });

  test('every output line ends with a line break and errors leave stdout empty', async () => {
    const r = await ledge(['balance'], { journal: BOOK });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.endsWith('\n'));
    assert.equal(r.stderr, '');
    const bad = await ledge(['balance'], { journal: BAD_JOURNAL });
    assert.equal(bad.stdout, '');
  });

  test('a failed command leaves no journal behind when there was none', async () => {
    const dir = workdir();
    fails(await ledge(['add', '2024-01-05', 'Shop', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'], { dir }), 5);
    assert.equal(read(dir, 'ledger.journal'), null);
  });
});
