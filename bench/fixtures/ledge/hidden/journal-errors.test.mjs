// Errors in the journal: exit 3, the file named and `line N`, the first error in reading order, nothing on stdout.
import { describe, test } from 'node:test';
import { failsAt, ledge, lines, workdir } from './helpers.mjs';

const head = ['account Assets:Bank', 'account Expenses:Food'];
const at = async (journal, line, args = ['check']) => failsAt(await ledge(args, { journal }), 3, 'ledger.journal', line);

describe('errors in the journal', { concurrency: true }, () => {
  test('a transaction that does not balance is reported at its date line', async () => {
    await at(lines(...head, '', '2024-01-05 Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.00 USD'), 4);
  });

  test('a transaction that balances in one currency but not in another', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -1.00 USD',
      '    Expenses:Food  1.00 EUR', '    Assets:Bank  -2.00 EUR'), 3);
  });

  test('a transaction with one posting', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  0.00 USD'), 3);
  });

  test('a transaction with no posting', async () => {
    await at(lines(...head, '2024-01-05 Shop', '', 'account Assets:Cash'), 3);
  });

  test('two postings without an amount', async () => {
    await at(lines(...head, 'account Assets:Cash', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank', '    Assets:Cash'), 4);
  });

  test('a missing amount with two currencies among the others', async () => {
    await at(lines(...head, 'account Assets:Cash', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Expenses:Food  1.00 EUR',
      '    Assets:Bank'), 4);
  });

  test('a posting to an account that is not declared', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Rent  1.00 USD', '    Assets:Bank  -1.00 USD'), 4);
  });

  test('an account declared after the posting that uses it', async () => {
    await at(lines('account Assets:Bank', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank', 'account Expenses:Food'), 3);
  });

  test('an account declared twice', async () => {
    await at(lines(...head, '# again', 'account Assets:Bank'), 4);
  });

  test('a malformed account name in a declaration', async () => {
    await at(lines('account Assets:Bank', 'account Savings:Jar'), 2);
  });

  test('an account part that starts with a digit', async () => {
    await at(lines('account Assets:2nd'), 1);
  });

  test('an account line with two names', async () => {
    await at(lines('account Assets:Bank Assets:Cash'), 1);
  });

  test('an amount with one decimal', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  42.1 USD', '    Assets:Bank'), 4);
  });

  test('an amount with a plus sign or a thousands separator', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  +1.00 USD', '    Assets:Bank'), 4);
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1,000.00 USD', '    Assets:Bank'), 4);
  });

  test('a currency that is not three capital letters', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 usd', '    Assets:Bank'), 4);
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USDT', '    Assets:Bank'), 4);
  });

  test('a posting with an amount and no currency', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00', '    Assets:Bank'), 4);
  });

  test('a posting with a fourth field', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD food', '    Assets:Bank'), 4);
  });

  test('a date that is not real', async () => {
    await at(lines(...head, '2023-02-29 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank'), 3);
    await at(lines(...head, '2024-13-01 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank'), 3);
  });

  test('a date line with no payee', async () => {
    await at(lines(...head, '2024-01-05   ', '    Expenses:Food  1.00 USD', '    Assets:Bank'), 3);
  });

  test('an unknown line', async () => {
    await at(lines(...head, 'commodity USD'), 3);
  });

  test('an indented line with no transaction open', async () => {
    await at(lines(...head, '', '    Expenses:Food  1.00 USD'), 4);
  });

  test('a posting after a blank line: the transaction ended at the blank line', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank', '', '    Assets:Bank  1.00 USD'), 7);
  });

  test('the first error in reading order wins', async () => {
    await at(lines(...head, 'bad line', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -2.00 USD'), 3);
  });

  test('a bad posting inside a transaction comes before its balance', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -2.00 USD', '    Expenses:Food  1.0 USD'), 6);
  });

  test('an unbalanced transaction comes before an error after its last posting', async () => {
    await at(lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -2.00 USD', 'bad line'), 3);
  });

  test('line numbers count blank and comment lines', async () => {
    await at(lines('# one', '', '; three', ...head, '', '', '2024-01-05 Shop', '    Expenses:Food  1.00 USD'), 8);
  });

  test('line numbers are right with CRLF line endings', async () => {
    await at(['account Assets:Bank', '', 'oops'].join('\r\n') + '\r\n', 3);
  });

  test('every command reads the journal first', async () => {
    const journal = lines(...head, 'oops');
    for (const args of [['accounts'], ['balance'], ['register'], ['report', 'month'], ['print'], ['export'], ['account', 'Assets:Cash']]) {
      await at(journal, 3, args);
    }
  });

  test('an error in an included file names that file and its line', async () => {
    const dir = workdir({
      'ledger.journal': lines(...head, 'include sub/cards.journal'),
      'sub/cards.journal': lines('', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -9.00 USD'),
    });
    failsAt(await ledge(['check'], { dir }), 3, 'cards.journal', 2);
  });

  test('an included file that does not exist is an error at the include line', async () => {
    failsAt(await ledge(['check'], { journal: lines(...head, '', 'include nowhere.journal') }), 3, 'ledger.journal', 4);
  });

  test('a file that includes itself is an include cycle at that line', async () => {
    const dir = workdir({ 'ledger.journal': lines(...head, 'include ledger.journal') });
    failsAt(await ledge(['check'], { dir }), 3, 'ledger.journal', 3);
  });

  test('an include cycle through another file is reported at the include that closes it', async () => {
    const dir = workdir({
      'ledger.journal': lines(...head, 'include b.journal'),
      'b.journal': lines('# b', 'include ledger.journal'),
    });
    failsAt(await ledge(['check'], { dir }), 3, 'b.journal', 2);
  });

  test('a transaction does not run on past the end of its included file', async () => {
    const dir = workdir({
      'ledger.journal': lines(...head, 'include t.journal', '    Assets:Bank  -1.00 USD'),
      't.journal': lines('2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -1.00 USD'),
    });
    failsAt(await ledge(['check'], { dir }), 3, 'ledger.journal', 4);
  });

  test('a file left unchanged by a write command that fails on the journal', async () => {
    const journal = lines(...head, 'oops');
    const dir = workdir();
    failsAt(await ledge(['add', '2024-01-05', 'Shop', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'], { dir, journal }), 3, 'ledger.journal', 3);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    if (readFileSync(join(dir, 'ledger.journal'), 'utf8') !== journal) throw new Error('the journal changed');
  });
});
