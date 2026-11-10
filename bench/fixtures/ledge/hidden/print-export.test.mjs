// `ledge print` (whole transactions in the form ledge writes) and `ledge export` (selected postings as CSV).
import { describe, test } from 'node:test';
import { BOOK, ledge, lines, ok } from './helpers.mjs';

const HEADER = 'date,payee,account,amount,currency';

describe('print and export', { concurrency: true }, () => {
  test('print: whole transactions in date order, in the written form, a blank line between them', async () => {
    ok(await ledge(['print', '--to', '2024-01-20'], { journal: BOOK }),
      '2024-01-01 Opening balance', '    Assets:Bank  1000.00 USD', '    Equity:Opening  -1000.00 USD', '',
      '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD', '',
      '2024-01-20 corner shop', '    Expenses:Food  10.00 USD', '    Assets:Cash  -10.00 USD');
  });

  test('print: a transaction with one selected posting is printed whole', async () => {
    ok(await ledge(['print', '--account', 'Liabilities'], { journal: BOOK }),
      '2024-02-03 Cafe Bleu', '    Expenses:Food:Coffee  4.50 EUR', '    Liabilities:Card  -4.50 EUR');
  });

  test('print: amounts normalised, the inferred amount filled in, payee and postings in their order', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-01\t  Open  it  ', '  Equity:E', '\tAssets:A   007.00   USD');
    ok(await ledge(['print'], { journal }), '2024-01-01 Open  it', '    Equity:E  -7.00 USD', '    Assets:A  7.00 USD');
  });

  test('print: the same date keeps reading order', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-02 Two', '    Assets:A  2.00 USD', '    Equity:E', '',
      '2024-01-01 One', '    Assets:A  1.00 USD', '    Equity:E', '', '2024-01-02 Three', '    Assets:A  3.00 USD', '    Equity:E');
    ok(await ledge(['print', '--account', 'Assets'], { journal }), '2024-01-01 One', '    Assets:A  1.00 USD', '    Equity:E  -1.00 USD', '',
      '2024-01-02 Two', '    Assets:A  2.00 USD', '    Equity:E  -2.00 USD', '', '2024-01-02 Three', '    Assets:A  3.00 USD', '    Equity:E  -3.00 USD');
  });

  test('print: nothing selected is no output', async () => {
    ok(await ledge(['print', '--from', '2025-01-01'], { journal: BOOK }));
  });

  test('export: the header, then one row per selected posting in date order', async () => {
    ok(await ledge(['export', '--account', 'Assets'], { journal: BOOK }), HEADER,
      '2024-01-01,Opening balance,Assets:Bank,1000.00,USD',
      '2024-01-05,Corner Shop,Assets:Bank,-42.10,USD',
      '2024-01-20,corner shop,Assets:Cash,-10.00,USD',
      '2024-01-31,ACME Ltd,Assets:Bank,3000.00,USD',
      '2024-02-01,Landlord,Assets:Bank,-1200.00,USD',
      '2024-04-02,ACME Ltd,Assets:Bank,3000.00,USD');
  });

  test('export: nothing selected is just the header row', async () => {
    ok(await ledge(['export']), HEADER);
  });

  test('export: a payee with a comma or a double quote is quoted, inner quotes doubled', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', '2024-01-01 Shop, the "best"', '    Assets:A  1.00 USD', '    Equity:E');
    ok(await ledge(['export'], { journal }), HEADER, '2024-01-01,"Shop, the ""best""",Assets:A,1.00,USD',
      '2024-01-01,"Shop, the ""best""",Equity:E,-1.00,USD');
  });

  test('export: other punctuation and spaces are written as they are', async () => {
    const journal = lines('account Assets:A', 'account Equity:E', "2024-01-01 Joe's  #1; deli", '    Assets:A  1.00 USD', '    Equity:E');
    ok(await ledge(['export', '--account', 'Equity'], { journal }), HEADER, "2024-01-01,Joe's  #1; deli,Equity:E,-1.00,USD");
  });

  test('export: the filters apply', async () => {
    ok(await ledge(['export', '--currency', 'EUR', '--payee', 'BLEU'], { journal: BOOK }), HEADER,
      '2024-02-03,Cafe Bleu,Expenses:Food:Coffee,4.50,EUR', '2024-02-03,Cafe Bleu,Liabilities:Card,-4.50,EUR');
  });
});
