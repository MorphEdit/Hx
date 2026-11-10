// `ledge report month|quarter|year`: income and expenses per period and currency, then the totals.
import { describe, test } from 'node:test';
import { BOOK, ledge, lines, ok } from './helpers.mjs';

describe('report', { concurrency: true }, () => {
  test('by month: one line per month and currency, then a total per currency', async () => {
    ok(await ledge(['report', 'month'], { journal: BOOK }),
      '2024-01 income 3000.00 USD expenses 52.10 USD net 2947.90 USD',
      '2024-02 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      '2024-02 income 0.00 USD expenses 1200.00 USD net -1200.00 USD',
      '2024-04 income 3000.00 USD expenses 0.00 USD net 3000.00 USD',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 6000.00 USD expenses 1252.10 USD net 4747.90 USD');
  });

  test('by quarter', async () => {
    ok(await ledge(['report', 'quarter'], { journal: BOOK }),
      '2024-Q1 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      '2024-Q1 income 3000.00 USD expenses 1252.10 USD net 1747.90 USD',
      '2024-Q2 income 3000.00 USD expenses 0.00 USD net 3000.00 USD',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 6000.00 USD expenses 1252.10 USD net 4747.90 USD');
  });

  test('by year', async () => {
    ok(await ledge(['report', 'year'], { journal: BOOK }),
      '2024 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      '2024 income 6000.00 USD expenses 1252.10 USD net 4747.90 USD',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 6000.00 USD expenses 1252.10 USD net 4747.90 USD');
  });

  test('quarters: March is Q1, April Q2, September Q3, October Q4', async () => {
    const journal = lines('account Expenses:X', 'account Assets:A',
      ...['2023-10-01', '2024-03-31', '2024-04-01', '2024-09-30'].flatMap((d) => [`${d} Pay`, '    Expenses:X  1.00 USD', '    Assets:A', '']));
    ok(await ledge(['report', 'quarter'], { journal }),
      '2023-Q4 income 0.00 USD expenses 1.00 USD net -1.00 USD',
      '2024-Q1 income 0.00 USD expenses 1.00 USD net -1.00 USD',
      '2024-Q2 income 0.00 USD expenses 1.00 USD net -1.00 USD',
      '2024-Q3 income 0.00 USD expenses 1.00 USD net -1.00 USD',
      'total income 0.00 USD expenses 4.00 USD net -4.00 USD');
  });

  test('a month with only asset and equity postings has no line', async () => {
    ok(await ledge(['report', 'month', '--to', '2024-01-01'], { journal: BOOK }), 'total income 0.00 expenses 0.00 net 0.00');
  });

  test('nothing to add up is the single zero total', async () => {
    ok(await ledge(['report', 'year']), 'total income 0.00 expenses 0.00 net 0.00');
  });

  test('the filters apply: --from and --to', async () => {
    ok(await ledge(['report', 'month', '--from', '2024-02-01', '--to', '2024-02-29'], { journal: BOOK }),
      '2024-02 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      '2024-02 income 0.00 USD expenses 1200.00 USD net -1200.00 USD',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 0.00 USD expenses 1200.00 USD net -1200.00 USD');
  });

  test('the filters apply: --account and --currency', async () => {
    ok(await ledge(['report', 'year', '--account', 'Expenses:Food'], { journal: BOOK }),
      '2024 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      '2024 income 0.00 USD expenses 52.10 USD net -52.10 USD',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 0.00 USD expenses 52.10 USD net -52.10 USD');
    ok(await ledge(['report', 'year', '--currency', 'EUR'], { journal: BOOK }),
      '2024 income 0.00 EUR expenses 4.50 EUR net -4.50 EUR',
      'total income 0.00 EUR expenses 4.50 EUR net -4.50 EUR');
  });

  test('the filters apply: --payee', async () => {
    ok(await ledge(['report', 'month', '--payee', 'acme'], { journal: BOOK }),
      '2024-01 income 3000.00 USD expenses 0.00 USD net 3000.00 USD',
      '2024-04 income 3000.00 USD expenses 0.00 USD net 3000.00 USD',
      'total income 6000.00 USD expenses 0.00 USD net 6000.00 USD');
  });

  test('a refund to an income account lowers the income; a refund from expenses lowers the expenses', async () => {
    const journal = lines('account Income:Job', 'account Expenses:Food', 'account Assets:A', '2024-05-01 Pay', '    Income:Job  -100.00 USD',
      '    Assets:A', '', '2024-05-02 Clawback', '    Income:Job  30.00 USD', '    Assets:A', '', '2024-05-03 Refund', '    Expenses:Food  -5.00 USD',
      '    Assets:A');
    ok(await ledge(['report', 'month'], { journal }), '2024-05 income 70.00 USD expenses -5.00 USD net 75.00 USD',
      'total income 70.00 USD expenses -5.00 USD net 75.00 USD');
  });

  test('periods sort by time across years', async () => {
    const journal = lines('account Expenses:X', 'account Assets:A', '2025-01-01 B', '    Expenses:X  2.00 USD', '    Assets:A', '',
      '2024-12-31 A', '    Expenses:X  1.00 USD', '    Assets:A');
    ok(await ledge(['report', 'year'], { journal }), '2024 income 0.00 USD expenses 1.00 USD net -1.00 USD',
      '2025 income 0.00 USD expenses 2.00 USD net -2.00 USD', 'total income 0.00 USD expenses 3.00 USD net -3.00 USD');
  });
});
