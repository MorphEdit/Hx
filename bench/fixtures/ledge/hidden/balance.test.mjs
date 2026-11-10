// `ledge balance`: one line per account and currency, the filters, --depth, --sort and the totals.
import { describe, test } from 'node:test';
import { BOOK, ledge, lines, ok } from './helpers.mjs';

const ALL = [
  'Assets:Bank 5757.90 USD', 'Assets:Cash -10.00 USD', 'Equity:Opening -1000.00 USD', 'Expenses:Food 52.10 USD',
  'Expenses:Food:Coffee 4.50 EUR', 'Expenses:Rent 1200.00 USD', 'Income:Salary -6000.00 USD', 'Liabilities:Card -4.50 EUR',
];

describe('balance', { concurrency: true }, () => {
  test('every account and currency, sorted by account, then the totals by currency', async () => {
    ok(await ledge(['balance'], { journal: BOOK }), ...ALL, 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('an empty journal is the single line total 0.00', async () => {
    ok(await ledge(['balance']), 'total 0.00');
  });

  test('nothing selected is the single line total 0.00', async () => {
    ok(await ledge(['balance', '--currency', 'THB'], { journal: BOOK }), 'total 0.00');
  });

  test('--account selects by prefix, never by a part of a name', async () => {
    ok(await ledge(['balance', '--account', 'Expenses:Food'], { journal: BOOK }), 'Expenses:Food 52.10 USD',
      'Expenses:Food:Coffee 4.50 EUR', 'total 4.50 EUR', 'total 52.10 USD');
  });

  test('--account with a name that is only the start of a part selects nothing', async () => {
    ok(await ledge(['balance', '--account', 'Expenses:Fo'], { journal: BOOK }), 'total 0.00');
  });

  test('--account given twice selects either', async () => {
    ok(await ledge(['balance', '--account', 'Income', '--account', 'Liabilities'], { journal: BOOK }),
      'Income:Salary -6000.00 USD', 'Liabilities:Card -4.50 EUR', 'total -4.50 EUR', 'total -6000.00 USD');
  });

  test('--from and --to are inclusive', async () => {
    ok(await ledge(['balance', '--from', '2024-01-05', '--to', '2024-01-31'], { journal: BOOK }),
      'Assets:Bank 2957.90 USD', 'Assets:Cash -10.00 USD', 'Expenses:Food 52.10 USD', 'Income:Salary -3000.00 USD', 'total 0.00 USD');
  });

  test('--from alone and --to alone', async () => {
    ok(await ledge(['balance', '--from', '2024-04-01'], { journal: BOOK }), 'Assets:Bank 3000.00 USD', 'Income:Salary -3000.00 USD', 'total 0.00 USD');
    ok(await ledge(['balance', '--to', '2024-01-01'], { journal: BOOK }), 'Assets:Bank 1000.00 USD', 'Equity:Opening -1000.00 USD', 'total 0.00 USD');
  });

  test('--payee is a part of the payee, ignoring the case of A-Z', async () => {
    ok(await ledge(['balance', '--payee', 'CORNER'], { journal: BOOK }), 'Assets:Bank -42.10 USD', 'Assets:Cash -10.00 USD',
      'Expenses:Food 52.10 USD', 'total 0.00 USD');
  });

  test('--currency selects that currency only', async () => {
    ok(await ledge(['balance', '--currency', 'EUR'], { journal: BOOK }), 'Expenses:Food:Coffee 4.50 EUR', 'Liabilities:Card -4.50 EUR', 'total 0.00 EUR');
  });

  test('every filter must hold', async () => {
    ok(await ledge(['balance', '--account', 'Assets', '--payee', 'acme', '--from', '2024-02-01'], { journal: BOOK }),
      'Assets:Bank 3000.00 USD', 'total 3000.00 USD');
  });

  test('--depth 1 adds up under the first part', async () => {
    ok(await ledge(['balance', '--depth', '1'], { journal: BOOK }), 'Assets 5747.90 USD', 'Equity -1000.00 USD', 'Expenses 4.50 EUR',
      'Expenses 1252.10 USD', 'Income -6000.00 USD', 'Liabilities -4.50 EUR', 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('--depth 2 keeps shorter names as they are', async () => {
    ok(await ledge(['balance', '--depth', '2', '--account', 'Expenses'], { journal: BOOK }), 'Expenses:Food 4.50 EUR',
      'Expenses:Food 52.10 USD', 'Expenses:Rent 1200.00 USD', 'total 4.50 EUR', 'total 1252.10 USD');
  });

  test('--depth larger than every name changes nothing', async () => {
    ok(await ledge(['balance', '--depth', '9'], { journal: BOOK }), ...ALL, 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('--sort amount: by currency, then largest amount first, then account', async () => {
    ok(await ledge(['balance', '--sort', 'amount'], { journal: BOOK }), 'Expenses:Food:Coffee 4.50 EUR', 'Liabilities:Card -4.50 EUR',
      'Assets:Bank 5757.90 USD', 'Expenses:Rent 1200.00 USD', 'Expenses:Food 52.10 USD', 'Assets:Cash -10.00 USD',
      'Equity:Opening -1000.00 USD', 'Income:Salary -6000.00 USD', 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('--sort amount breaks a tie by account', async () => {
    const journal = lines('account Assets:B', 'account Assets:A', 'account Equity:E', '2024-01-01 Open', '    Assets:B  5.00 USD',
      '    Assets:A  5.00 USD', '    Equity:E');
    ok(await ledge(['balance', '--sort', 'amount'], { journal }), 'Assets:A 5.00 USD', 'Assets:B 5.00 USD', 'Equity:E -10.00 USD', 'total 0.00 USD');
  });

  test('--sort name is the default order', async () => {
    ok(await ledge(['balance', '--sort', 'name'], { journal: BOOK }), ...ALL, 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('a sum of zero is still shown', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-01 In', '    Assets:A  5.00 USD', '    Equity:E', '',
      '2024-01-02 Out', '    Assets:A  -5.00 USD', '    Equity:E');
    ok(await ledge(['balance', '--account', 'Assets'], { journal }), 'Assets:A 0.00 USD', 'total 0.00 USD');
  });

  test('account names sort by character code: capitals first', async () => {
    const journal = lines('account Assets:bank', 'account Assets:Zoo', 'account Equity:E', '2024-01-01 Open', '    Assets:bank  1.00 USD',
      '    Assets:Zoo  1.00 USD', '    Equity:E');
    ok(await ledge(['balance', '--account', 'Assets'], { journal }), 'Assets:Zoo 1.00 USD', 'Assets:bank 1.00 USD', 'total 2.00 USD');
  });

  test('amounts print without leading zeros and with a minus for negative ones', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-01 Open', '    Assets:A  0000.05 USD', '    Equity:E');
    ok(await ledge(['balance'], { journal }), 'Assets:A 0.05 USD', 'Equity:E -0.05 USD', 'total 0.00 USD');
  });
});
