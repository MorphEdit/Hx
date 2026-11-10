// `ledge import`: a bank's CSV file into one account, payees mapped by rules, duplicates skipped.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { failsAt, fails, ledge, lines, ok, read, workdir } from './helpers.mjs';

const head = lines('account Assets:Bank', 'account Expenses:Food', 'account Expenses:Unknown', 'account Income:Salary');
const CSV = lines('date,payee,amount,currency', '2024-02-01,Corner Shop,-5.25,USD', '2024-02-03,ACME Ltd,3000.00,USD');
const posted = (date, payee, account, amount, other, minus) => lines('', `${date} ${payee}`, `    ${account}  ${amount}`, `    ${other}  ${minus}`);

/** A folder with the journal and `files`; runs the import; → { r, after }. */
async function run(args, files, journal = head) {
  const dir = workdir(files);
  const r = await ledge(args, { dir, journal });
  return { r, after: read(dir, 'ledger.journal'), dir };
}

describe('import', { concurrency: true }, () => {
  test('each row becomes a transaction: the account with the amount, the other account with the sign turned over', async () => {
    const { r, after } = await run(['import', 'bank.csv', '--account', 'Assets:Bank'], { 'bank.csv': CSV });
    ok(r, 'imported 2, skipped 0');
    assert.equal(after, head + posted('2024-02-01', 'Corner Shop', 'Assets:Bank', '-5.25 USD', 'Expenses:Unknown', '5.25 USD')
      + posted('2024-02-03', 'ACME Ltd', 'Assets:Bank', '3000.00 USD', 'Expenses:Unknown', '-3000.00 USD'));
  });

  test('the columns may come in any order, and other columns are ignored', async () => {
    const csv = lines('currency,memo,amount,date,payee', 'USD,x,-1.00,2024-02-01,Shop');
    const { r, after } = await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv });
    ok(r, 'imported 1, skipped 0');
    assert.ok(after.endsWith(lines('2024-02-01 Shop', '    Assets:Bank  -1.00 USD', '    Expenses:Unknown  1.00 USD')), after);
  });

  test('the rules map payees to accounts: the first rule whose text the payee contains, case of A-Z ignored', async () => {
    const rules = lines('# rules', '', 'Expenses:Food   corner shop ', 'Income:Salary acme', 'Expenses:Food ACME');
    const { r, after } = await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'], { 'bank.csv': CSV, 'r.txt': rules });
    ok(r, 'imported 2, skipped 0');
    assert.equal(after, head + posted('2024-02-01', 'Corner Shop', 'Assets:Bank', '-5.25 USD', 'Expenses:Food', '5.25 USD')
      + posted('2024-02-03', 'ACME Ltd', 'Assets:Bank', '3000.00 USD', 'Income:Salary', '-3000.00 USD'));
  });

  test('with no matching rule the other account is --default', async () => {
    const { after } = await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt', '--default', 'Expenses:Food'],
      { 'bank.csv': CSV, 'r.txt': lines('Income:Salary acme') });
    assert.ok(after.includes(lines('2024-02-01 Corner Shop', '    Assets:Bank  -5.25 USD', '    Expenses:Food  5.25 USD')), after);
    assert.ok(after.includes(lines('2024-02-03 ACME Ltd', '    Assets:Bank  3000.00 USD', '    Income:Salary  -3000.00 USD')), after);
  });

  test('a row already in the journal is a duplicate and is skipped', async () => {
    const journal = head + lines('', '2024-02-01 Corner Shop', '    Assets:Bank  -5.25 USD', '    Expenses:Food');
    const { r, after } = await run(['import', 'bank.csv', '--account', 'Assets:Bank'], { 'bank.csv': CSV }, journal);
    ok(r, 'imported 1, skipped 1');
    assert.equal(after, journal + posted('2024-02-03', 'ACME Ltd', 'Assets:Bank', '3000.00 USD', 'Expenses:Unknown', '-3000.00 USD'));
  });

  test('a row repeated in the file is imported once', async () => {
    const csv = lines('date,payee,amount,currency', '2024-02-01,Shop,-1.00,USD', '2024-02-01,Shop,-1.00,USD', '2024-02-01,Shop,-2.00,USD');
    ok((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv })).r, 'imported 2, skipped 1');
  });

  test('a duplicate needs the same date, payee, account, amount and currency', async () => {
    const journal = head + lines('', '2024-02-01 Shop', '    Assets:Bank  -1.00 USD', '    Expenses:Food');
    const csv = lines('date,payee,amount,currency', '2024-02-02,Shop,-1.00,USD', '2024-02-01,shop,-1.00,USD', '2024-02-01,Shop,-1.00,EUR',
      '2024-02-01,Shop,1.00,USD', '2024-02-01,Shop,-1.00,USD');
    ok((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv }, journal)).r, 'imported 4, skipped 1');
  });

  test('a posting to another account does not make a duplicate', async () => {
    const journal = head + lines('account Assets:Cash', '', '2024-02-01 Shop', '    Assets:Cash  -1.00 USD', '    Expenses:Food');
    ok((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': lines('date,payee,amount,currency', '2024-02-01,Shop,-1.00,USD') }, journal)).r,
      'imported 1, skipped 0');
  });

  test('quoted fields: commas, doubled quotes; whitespace at the ends of a field is dropped', async () => {
    const csv = 'date,payee,amount,currency\r\n 2024-02-01 ,"Shop, the ""best""", -1.00 ,USD\r\n';
    const { r, after } = await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv });
    ok(r, 'imported 1, skipped 0');
    assert.ok(after.endsWith(lines('2024-02-01 Shop, the "best"', '    Assets:Bank  -1.00 USD', '    Expenses:Unknown  1.00 USD')), after);
  });

  test('blank lines in the CSV are skipped', async () => {
    const csv = lines('date,payee,amount,currency', '', '2024-02-01,Shop,-1.00,USD', '', '');
    ok((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv })).r, 'imported 1, skipped 0');
  });

  test('a CSV with only its header imports nothing', async () => {
    const { r, after } = await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': lines('date,payee,amount,currency') });
    ok(r, 'imported 0, skipped 0');
    assert.equal(after, head);
  });

  test('a missing column is exit 4 at line 1', async () => {
    failsAt((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': lines('date,payee,amount', '2024-02-01,Shop,-1.00') })).r, 4, 'b.csv', 1);
  });

  test('a wrong row is exit 4 with the CSV file and its line, and nothing is written', async () => {
    for (const row of ['2024-02-30,Shop,-1.00,USD', '2024-02-01,,-1.00,USD', '2024-02-01,Shop,-1.0,USD', '2024-02-01,Shop,-1.00,usd',
      '2024-02-01,Shop,-1.00', '2024-02-01,Shop,-1.00,USD,extra']) {
      const { r, after } = await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': lines('date,payee,amount,currency', '2024-02-01,Ok,-1.00,USD', row) });
      failsAt(r, 4, 'b.csv', 3);
      assert.equal(after, head);
    }
  });

  test('the line of a row is the line it starts on, after a quoted line break', async () => {
    const csv = 'date,payee,amount,currency,memo\n2024-02-01,Shop,-1.00,USD,"two\nlines"\n2024-02-01,Shop,x,USD,m\n';
    failsAt((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv })).r, 4, 'b.csv', 4);
  });

  test('a payee with a line break is exit 4', async () => {
    const csv = 'date,payee,amount,currency\n2024-02-01,"Sh\nop",-1.00,USD\n';
    failsAt((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': csv })).r, 4, 'b.csv', 2);
  });

  test('a quote that is never closed, or text after a closing quote, is exit 4', async () => {
    fails((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': 'date,payee,amount,currency\n2024-02-01,"Shop,-1.00,USD\n' })).r, 4);
    failsAt((await run(['import', 'b.csv', '--account', 'Assets:Bank'], { 'b.csv': 'date,payee,amount,currency\n2024-02-01,"Shop"x,-1.00,USD\n' })).r, 4, 'b.csv', 2);
  });

  test('a wrong rule is exit 4 with the rules file and its line', async () => {
    for (const rule of ['Expenses:Food', 'Food corner', 'Expenses:Food   \t']) {
      failsAt((await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'], { 'bank.csv': CSV, 'r.txt': lines('# r', rule) })).r,
        4, 'r.txt', 2);
    }
  });

  test('a wrong CSV wins over a wrong rules file', async () => {
    failsAt((await run(['import', 'b.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'],
      { 'b.csv': lines('date,payee,amount,currency', 'bad,Shop,-1.00,USD'), 'r.txt': lines('nonsense here') })).r, 4, 'b.csv', 2);
  });

  test('--account that is not declared is exit 5, even when every row is a duplicate', async () => {
    const { r, after } = await run(['import', 'bank.csv', '--account', 'Assets:Cash'], { 'bank.csv': CSV });
    fails(r, 5);
    assert.equal(after, head);
  });

  test('another account a row would use that is not declared is exit 5, nothing written', async () => {
    const journal = lines('account Assets:Bank', 'account Expenses:Food');
    const { r, after } = await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'], { 'bank.csv': CSV, 'r.txt': lines('Expenses:Food corner') }, journal);
    fails(r, 5);
    assert.equal(after, journal);
  });

  test('a duplicate row needs no declared other account', async () => {
    const journal = lines('account Assets:Bank', 'account Expenses:Food', '', '2024-02-03 ACME Ltd', '    Assets:Bank  3000.00 USD', '    Expenses:Food');
    const { r } = await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'], { 'bank.csv': CSV, 'r.txt': lines('Expenses:Food corner') }, journal);
    ok(r, 'imported 1, skipped 1');
  });

  test('usage: --account is required, given once, and well-formed; one CSV file', async () => {
    const files = { 'bank.csv': CSV };
    fails((await run(['import', 'bank.csv'], files)).r, 1);
    fails((await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--account', 'Assets:Bank'], files)).r, 1);
    fails((await run(['import', 'bank.csv', '--account', 'bank'], files)).r, 1);
    fails((await run(['import', '--account', 'Assets:Bank'], files)).r, 1);
    fails((await run(['import', 'bank.csv', 'more.csv', '--account', 'Assets:Bank'], files)).r, 1);
    fails((await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--default', 'x'], files)).r, 1);
  });

  test('a missing CSV file or rules file is exit 2, the CSV file first', async () => {
    fails((await run(['import', 'none.csv', '--account', 'Assets:Bank'], {})).r, 2);
    fails((await run(['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'none.txt'], { 'bank.csv': CSV })).r, 2);
    const both = (await run(['import', 'none.csv', '--account', 'Assets:Bank', '--rules', 'none.txt'], {})).r;
    fails(both, 2);
    assert.ok(both.stderr.includes('none.csv'), both.stderr);
  });

  test('imported transactions read back into the balance', async () => {
    const { dir } = await run(['import', 'bank.csv', '--account', 'Assets:Bank'], { 'bank.csv': CSV });
    ok(await ledge(['balance', '--account', 'Assets'], { dir }), 'Assets:Bank 2994.75 USD', 'total 2994.75 USD');
  });
});
