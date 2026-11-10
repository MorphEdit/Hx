// `ledge register`: one line per selected posting with its running total per currency, in date order or by amount.
import { describe, test } from 'node:test';
import { BOOK, ledge, lines, ok } from './helpers.mjs';

describe('register', { concurrency: true }, () => {
  test('every posting in date order, then reading order, then posting order', async () => {
    ok(await ledge(['register'], { journal: BOOK }),
      '2024-01-01 Opening balance  Assets:Bank  1000.00 USD  1000.00 USD',
      '2024-01-01 Opening balance  Equity:Opening  -1000.00 USD  0.00 USD',
      '2024-01-05 Corner Shop  Expenses:Food  42.10 USD  42.10 USD',
      '2024-01-05 Corner Shop  Assets:Bank  -42.10 USD  0.00 USD',
      '2024-01-20 corner shop  Expenses:Food  10.00 USD  10.00 USD',
      '2024-01-20 corner shop  Assets:Cash  -10.00 USD  0.00 USD',
      '2024-01-31 ACME Ltd  Assets:Bank  3000.00 USD  3000.00 USD',
      '2024-01-31 ACME Ltd  Income:Salary  -3000.00 USD  0.00 USD',
      '2024-02-01 Landlord  Expenses:Rent  1200.00 USD  1200.00 USD',
      '2024-02-01 Landlord  Assets:Bank  -1200.00 USD  0.00 USD',
      '2024-02-03 Cafe Bleu  Expenses:Food:Coffee  4.50 EUR  4.50 EUR',
      '2024-02-03 Cafe Bleu  Liabilities:Card  -4.50 EUR  0.00 EUR',
      '2024-04-02 ACME Ltd  Assets:Bank  3000.00 USD  3000.00 USD',
      '2024-04-02 ACME Ltd  Income:Salary  -3000.00 USD  0.00 USD');
  });

  test('the running total of one account', async () => {
    ok(await ledge(['register', '--account', 'Assets:Bank'], { journal: BOOK }),
      '2024-01-01 Opening balance  Assets:Bank  1000.00 USD  1000.00 USD',
      '2024-01-05 Corner Shop  Assets:Bank  -42.10 USD  957.90 USD',
      '2024-01-31 ACME Ltd  Assets:Bank  3000.00 USD  3957.90 USD',
      '2024-02-01 Landlord  Assets:Bank  -1200.00 USD  2757.90 USD',
      '2024-04-02 ACME Ltd  Assets:Bank  3000.00 USD  5757.90 USD');
  });

  test('each currency has its own running total', async () => {
    ok(await ledge(['register', '--account', 'Expenses'], { journal: BOOK }),
      '2024-01-05 Corner Shop  Expenses:Food  42.10 USD  42.10 USD',
      '2024-01-20 corner shop  Expenses:Food  10.00 USD  52.10 USD',
      '2024-02-01 Landlord  Expenses:Rent  1200.00 USD  1252.10 USD',
      '2024-02-03 Cafe Bleu  Expenses:Food:Coffee  4.50 EUR  4.50 EUR');
  });

  test('the same date keeps reading order, whatever the payee', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-01 Zed', '    Assets:A  1.00 USD', '    Equity:E', '',
      '2024-01-01 Abe', '    Assets:A  2.00 USD', '    Equity:E');
    ok(await ledge(['register', '--account', 'Assets'], { journal }), '2024-01-01 Zed  Assets:A  1.00 USD  1.00 USD',
      '2024-01-01 Abe  Assets:A  2.00 USD  3.00 USD');
  });

  test('--sort amount: largest first, the running total in that order', async () => {
    ok(await ledge(['register', '--account', 'Assets:Bank', '--sort', 'amount'], { journal: BOOK }),
      '2024-01-31 ACME Ltd  Assets:Bank  3000.00 USD  3000.00 USD',
      '2024-04-02 ACME Ltd  Assets:Bank  3000.00 USD  6000.00 USD',
      '2024-01-01 Opening balance  Assets:Bank  1000.00 USD  7000.00 USD',
      '2024-01-05 Corner Shop  Assets:Bank  -42.10 USD  6957.90 USD',
      '2024-02-01 Landlord  Assets:Bank  -1200.00 USD  5757.90 USD');
  });

  test('--sort amount puts a negative amount after a positive one', async () => {
    ok(await ledge(['register', '--payee', 'cafe', '--sort', 'amount'], { journal: BOOK }),
      '2024-02-03 Cafe Bleu  Expenses:Food:Coffee  4.50 EUR  4.50 EUR',
      '2024-02-03 Cafe Bleu  Liabilities:Card  -4.50 EUR  0.00 EUR');
  });

  test('--sort date is the default order', async () => {
    ok(await ledge(['register', '--account', 'Assets:Cash', '--sort', 'date'], { journal: BOOK }),
      '2024-01-20 corner shop  Assets:Cash  -10.00 USD  -10.00 USD');
  });

  test('filters by date and payee', async () => {
    ok(await ledge(['register', '--from', '2024-02-01', '--to', '2024-03-31', '--payee', 'LAND'], { journal: BOOK }),
      '2024-02-01 Landlord  Expenses:Rent  1200.00 USD  1200.00 USD',
      '2024-02-01 Landlord  Assets:Bank  -1200.00 USD  0.00 USD');
  });

  test('filters by currency', async () => {
    ok(await ledge(['register', '--currency', 'EUR', '--account', 'Liabilities'], { journal: BOOK }),
      '2024-02-03 Cafe Bleu  Liabilities:Card  -4.50 EUR  -4.50 EUR');
  });

  test('an inferred amount is shown like any other', async () => {
    ok(await ledge(['register', '--account', 'Equity'], { journal: BOOK }),
      '2024-01-01 Opening balance  Equity:Opening  -1000.00 USD  -1000.00 USD');
  });

  test('nothing selected is no output', async () => {
    ok(await ledge(['register', '--payee', 'nobody'], { journal: BOOK }));
  });

  test('an empty journal is no output', async () => {
    ok(await ledge(['register']));
  });
});
