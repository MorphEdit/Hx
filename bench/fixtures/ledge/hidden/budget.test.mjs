// `ledge budget`: a month's spending against the limits of the budget file.
import { describe, test } from 'node:test';
import { BOOK, failsAt, fails, ledge, lines, ok, workdir } from './helpers.mjs';

/** A folder with the BOOK journal and `budget` as ledge.budget beside it. */
const book = (budget, more = {}) => workdir({ 'ledger.journal': BOOK, ...(budget === undefined ? {} : { 'ledge.budget': budget }), ...more });

describe('budget', { concurrency: true }, () => {
  test('one line per limit: spent of limit, the percent, and what is left', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Rent 1500.00 USD')) }), 'Expenses:Rent 1200.00 of 1500.00 USD 80% left 300.00');
  });

  test('spending over the limit says over', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Rent 1000.00 USD')) }), 'Expenses:Rent 1200.00 of 1000.00 USD 120% over 200.00');
  });

  test('spending exactly the limit is left 0.00', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Rent 1200.00 USD')) }), 'Expenses:Rent 1200.00 of 1200.00 USD 100% left 0.00');
  });

  test('spent counts the account and every account under it, in that currency, in that month', async () => {
    ok(await ledge(['budget', '2024-01'], { dir: book(lines('Expenses:Food 100.00 USD', 'Expenses 100.00 EUR')) }),
      'Expenses 0.00 of 100.00 EUR 0% left 100.00', 'Expenses:Food 52.10 of 100.00 USD 52% left 47.90');
  });

  test('lines sort by account, then currency, whatever the file order', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Rent 2000.00 USD', 'Expenses:Food 10.00 USD', 'Expenses:Food 10.00 EUR')) }),
      'Expenses:Food 4.50 of 10.00 EUR 45% left 5.50', 'Expenses:Food 0.00 of 10.00 USD 0% left 10.00',
      'Expenses:Rent 1200.00 of 2000.00 USD 60% left 800.00');
  });

  test('the month defaults to the month of today', async () => {
    ok(await ledge(['budget'], { dir: book(lines('Expenses:Food 20.00 EUR')), today: '2024-02-29' }), 'Expenses:Food 4.50 of 20.00 EUR 23% left 15.50');
  });

  test('the percent rounds a half up', async () => {
    // 4.50 of 36.00 is 12.5%: 13
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Food 36.00 EUR')) }), 'Expenses:Food 4.50 of 36.00 EUR 13% left 31.50');
  });

  test('the percent rounds below a half down', async () => {
    // 4.50 of 37.00 is 12.16%: 12
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Food 37.00 EUR')) }), 'Expenses:Food 4.50 of 37.00 EUR 12% left 32.50');
  });

  test('negative spending: left is more than the limit, a negative half rounds toward the larger number', async () => {
    const journal = lines('account Expenses:Food', 'account Assets:A', '2024-06-03 Refund', '    Expenses:Food  -2.00 USD', '    Assets:A');
    // -2.00 of 16.00 is -12.5%: -12
    ok(await ledge(['budget', '2024-06'], { dir: workdir({ 'ledge.budget': lines('Expenses:Food 16.00 USD') }), journal }),
      'Expenses:Food -2.00 of 16.00 USD -12% left 18.00');
  });

  test('blank and comment lines are skipped; the account need not be declared', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('# monthly', '', '  ', 'Expenses:Fun   50.00\tUSD')) }), 'Expenses:Fun 0.00 of 50.00 USD 0% left 50.00');
  });

  test('a budget file with no limits prints nothing', async () => {
    ok(await ledge(['budget', '2024-02'], { dir: book(lines('# nothing yet')) }));
  });

  test('--budget names another budget file', async () => {
    ok(await ledge(['budget', '2024-02', '--budget', 'plans/b.txt'], { dir: book(undefined, { 'plans/b.txt': lines('Expenses:Rent 1500.00 USD') }) }),
      'Expenses:Rent 1200.00 of 1500.00 USD 80% left 300.00');
  });

  test('the default budget file is in the journal folder', async () => {
    const dir = workdir({ 'books/ledger.journal': BOOK, 'books/ledge.budget': lines('Expenses:Rent 1500.00 USD') });
    ok(await ledge(['budget', '2024-02'], { dir, file: 'books/ledger.journal' }), 'Expenses:Rent 1200.00 of 1500.00 USD 80% left 300.00');
  });

  test('a missing budget file is exit 2', async () => {
    fails(await ledge(['budget', '2024-02'], { dir: book(undefined) }), 2);
    fails(await ledge(['budget', '2024-02', '--budget', 'none.txt'], { dir: book(lines('Expenses:Rent 1.00 USD')) }), 2);
  });

  test('a malformed month is exit 1', async () => {
    for (const m of ['2024-13', '2024-2', '2024-02-01', 'feb']) fails(await ledge(['budget', m], { dir: book(lines('Expenses:Rent 1.00 USD')) }), 1);
  });

  test('a wrong budget line is exit 4 with the file and its line', async () => {
    for (const bad of ['Expenses:Rent 1.00', 'Rent 1.00 USD', 'Expenses:Rent 1.0 USD', 'Expenses:Rent 0.00 USD', 'Expenses:Rent -5.00 USD',
      'Expenses:Rent 1.00 usd', 'Expenses:Rent 1.00 USD x']) {
      failsAt(await ledge(['budget', '2024-02'], { dir: book(lines('# ok', 'Expenses:Food 1.00 USD', bad)) }), 4, 'ledge.budget', 3);
    }
  });

  test('a second limit for the same account and currency is exit 4', async () => {
    failsAt(await ledge(['budget', '2024-02'], { dir: book(lines('Expenses:Food 1.00 USD', 'Expenses:Food 1.00 EUR', 'Expenses:Food 2.00 USD')) }),
      4, 'ledge.budget', 3);
  });

  test('a bad journal wins over a bad budget file', async () => {
    fails(await ledge(['budget', '2024-02'], { dir: workdir({ 'ledge.budget': lines('nonsense') }), journal: lines('oops') }), 3);
  });
});
