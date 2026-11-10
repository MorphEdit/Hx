# ledge

I want `ledge`, a small Node tool for my personal accounts: a command-line program and a library I can import. No
dependencies. My money lives in one plain-text journal that I can open and fix by hand, in a strict double-entry
format, and ledge answers questions about it: balances, a register, monthly reports, a budget, and CSV in and out.

## Files and dates
- The journal is the file named by the `LEDGE_FILE` environment variable; without it, `ledger.journal` in the current
  folder. A journal that does not exist yet is an empty journal. The commands that write create it.
- Dates are written `YYYY-MM-DD` and must be real dates (`2024-02-30` is wrong). There are no times or time zones.
- "Today" is the `LEDGE_TODAY` environment variable (a date, e.g. `LEDGE_TODAY=2024-03-15`); if it is not set, the
  computer's local date. If it is set but is not a real date, every command fails with it (exit 2), even one that does
  not use today.
- Amounts are written with exactly two decimals and an optional leading minus: `42.10`, `-7.00`, `0.50`, `1200.00`.
  No plus sign, no thousands separators, no other number of decimals. ledge works in whole cents, so sums are exact
  and are never rounded. ledge always prints an amount the same way: a minus for a negative amount, no leading zeros
  (`007.50` is printed `7.50`), and zero as `0.00` (never `-0.00`).
- A currency is exactly three capital letters (`USD`, `EUR`, `THB`).
- An account name is one or more parts joined by `:`, e.g. `Expenses:Food:Coffee`. The first part is one of `Assets`,
  `Liabilities`, `Equity`, `Income` and `Expenses`. Every part starts with a letter and holds only letters, digits,
  `-` and `_`. Letters are `A`–`Z` and `a`–`z`; names are case-sensitive.
- An account `P` is a prefix of an account `A` when `A` is `P` or starts with `P:`. So `Expenses` and
  `Expenses:Food` are prefixes of `Expenses:Food:Coffee`, but `Expenses:Fo` is not.
- Sorting text (account names, currencies, payees) is by character code, so capital letters come before small ones.

## The journal format

    # my accounts
    account Assets:Checking
    account Expenses:Food
    account Income:Salary

    2024-01-05 Corner Shop
        Expenses:Food       42.10 USD
        Assets:Checking    -42.10 USD

    2024-01-31 ACME Ltd
        Assets:Checking   3000.00 USD
        Income:Salary

    include cards.journal

The journal is read line by line. "Whitespace" is spaces and tabs; any run of whitespace separates fields. Lines may
end with LF or CRLF, and may have whitespace at the end.
- A **blank line** holds only whitespace. A **comment line**'s first non-whitespace character is `#` or `;`.
  Comment lines are ignored wherever they are, also between the postings of a transaction.
- `account <name>` declares an account. Every account must be declared before (above, in reading order) any posting
  that uses it. Declaring an account a second time is an error.
- `include <path>` reads another journal file in place of that line, as if its lines were there. The path is the rest
  of the line (it may hold spaces), relative to the folder of the file that holds the `include`. A file that includes
  itself, directly or through other files, is an error (an include cycle) at the `include` line that closes the cycle.
  An included file that does not exist is an error at its `include` line.
- A **transaction** starts with a date line: a date at the very start of the line, whitespace, then the payee, which
  is the rest of the line without the whitespace at its end. The payee must not be empty.
- The lines right after the date line that start with whitespace (and are not blank or comments) are its
  **postings**: `<account> <amount> <currency>`, or `<account>` alone. Anything else on a posting line is an error.
  A blank line, any line that does not start with whitespace, or the end of its file ends the transaction.
- A transaction has at least two postings. At most one posting may leave out its amount: it gets the amount that
  makes the transaction balance, in the one currency of the other postings; when the other postings use more than one
  currency, that is an error. In every currency, the amounts of a transaction add up to exactly `0.00`, or it is an
  error. A transaction may post to the same account twice.
- A line that starts with something other than whitespace and is not a comment, an `account`, an `include` or a date
  line is an error. So is a line that starts with whitespace when no transaction is open.
- Transactions need not be in date order. **Reading order** is the order of the lines with every include in place.

### Errors in the journal
The first error in reading order is the one reported. Each line is checked when it is read; a transaction's own checks
(at least two postings, at most one posting without an amount, the inferred currency, the balance) are made when its
last posting has been read, and are reported at its date line. So a bad posting inside a transaction is reported
before that transaction's balance, and an unbalanced transaction is reported before any error after its last posting.
An error message names the file (at least the last part of its path, e.g. `cards.journal`) and contains `line N`, its
line number in that file counting every line from 1 (blank and comment lines included), e.g.
`ledger.journal line 7: transaction does not balance in USD`. The exact wording is up to you.

## The command line
Output goes to stdout, and every line of output ends with `\n`. Errors go to stderr only, never stdout, and on any
error stdout is empty and no file is changed. An error is a message the CLI prints and exits with, never an uncaught
exception.

### Exit codes, and which error wins
When several things are wrong, the first one in this list is reported, with its exit code:

1. **Usage, exit 1:** an unknown or missing command, a missing or extra argument, an unknown option, an option the
   command does not take, an option given twice (other than `--account`), an option without its value, or a value
   that is not valid where the command line is read (a malformed date, month, account name, currency, amount or
   number; `--from` after `--to`). Nothing is read before these are checked.
2. **Environment, exit 2:** `LEDGE_TODAY` set but not a real date; then a file named on the command line, or the
   budget file, that does not exist or cannot be read (for `import`: the CSV file first, then the rules file).
3. **The journal, exit 3:** any error in the journal or a file it includes, as above.
4. **The other input files, exit 4:** an error in the content of the CSV file, the rules file or the budget file
   (for `import`: the CSV file first, then the rules file). Their errors name the file and contain `line N` like the
   journal's.
5. **The command's own checks, exit 5:** what the command checks against the journal (below).

Exit `0` is success.

### Options and filters
Options come after the command, in any order and mixed with its arguments; each takes the next argument as its value,
whatever that value looks like. Anything else that starts with `-` is an unknown option. `add` takes no options.

The **filters** are taken by `balance`, `register`, `report`, `print` and `export`. A posting is selected when all the
filters given hold for it:
- `--account <name>` (may be repeated): one of the given names is a prefix of the posting's account;
- `--from <date>`, `--to <date>`: its transaction's date is on or after `--from`, on or before `--to`;
- `--payee <text>`: its transaction's payee contains the text, ignoring the case of `A`–`Z`;
- `--currency <cur>`: its currency is that one.

### Commands
- `ledge check` reads the journal and prints `ok: N transactions, M accounts` (the counts of all transactions and
  declared accounts, includes counted; the words stay plural, e.g. `ok: 1 transactions, 0 accounts`).
- `ledge accounts` prints the declared accounts, one per line, sorted. No accounts: no output.
- `ledge account <name>` declares an account by adding the line `account <name>` to the journal, and prints
  `declared <name>`. An account that is already declared: exit 5.
- `ledge add <date> <payee> <account> [<amount> <currency>] <account> [<amount> <currency>] ...` adds a
  transaction. The date may also be `today`. The payee is one argument (quote it); whitespace at either end of it is
  dropped, and it must then not be empty or hold a line break. After it, each posting is an account, followed by an amount and a currency or by nothing; there must be at
  least two postings. These are usage errors (exit 1). Then, against the journal (exit 5, the first that applies): an
  account that is not declared (the first one, in posting order); more than one posting without an amount; a missing
  amount with more than one currency among the others; amounts that do not balance. The transaction is written with
  the inferred amount filled in, and ledge prints `added <date> <payee>` (the date as written to the journal).
- `ledge balance [filters] [--depth N] [--sort name|amount]` prints one line per account and currency of the selected
  postings: `<account> <amount> <currency>`, the sum of those postings. A sum of zero is still shown.
  - `--depth N` (written with digits only, at least 1) first cuts every account name to its first N parts, and adds up the
    accounts that become the same name.
  - Lines are sorted by account, then currency. With `--sort amount` they are sorted by currency, then amount from
    largest to smallest, then account.
  - Then one `total <amount> <currency>` line per currency (the sum of that currency's lines), sorted by currency.
    With no selected posting the output is the single line `total 0.00`.
- `ledge register [filters] [--sort date|amount]` prints one line per selected posting:
  `<date> <payee>  <account>  <amount> <currency>  <running> <currency>` (one space after the date, two spaces
  between the other parts), where `running` is the sum of the lines printed so far in that currency, this one
  included. The order is by date, then reading order, then the posting's order in its transaction. With
  `--sort amount` it is by amount from largest to smallest, ties in the date order. No selected posting: no output.
- `ledge report month|quarter|year [filters]` adds up the selected postings to `Income` and `Expenses` accounts (all
  other postings are left out) per period and currency. A period is written `2024-03`, `2024-Q1` (Q1 is January to
  March) or `2024`. Each line is
  `<period> income <income> <cur> expenses <expenses> <cur> net <net> <cur>`, where income is the sum of the
  `Income` postings with its sign turned over (salary posted as `-3000.00` is income `3000.00`), expenses is the sum
  of the `Expenses` postings, and net is income minus expenses. One line per period and currency that has at least
  one such posting, sorted by period, then currency. Then a
  `total income <income> <cur> expenses <expenses> <cur> net <net> <cur>` line per currency, sorted by currency. With
  nothing to add up, the output is the single line `total income 0.00 expenses 0.00 net 0.00`.
- `ledge print [filters]` prints every transaction that has at least one selected posting, whole (all its postings), in
  date order, then reading order, in the form ledge writes (below), with one blank line between transactions. Nothing
  selected: no output.
- `ledge export [filters]` prints the selected postings as CSV (below), in the register's date order.
- `ledge budget [YYYY-MM] [--budget <file>]` compares a month's spending with the budget. The month defaults to the
  month of today. The budget file is `--budget`'s, or else `ledge.budget` in the journal's folder; a budget file that
  does not exist is exit 2. For each budget line, sorted by account, then currency, it prints
  `<account> <spent> of <limit> <cur> <percent>% left <left>` or, when spent is more than the limit,
  `<account> <spent> of <limit> <cur> <percent>% over <over>`. Spent is the sum of that month's postings, in that
  currency, to the account and every account it is a prefix of. `left` is limit minus spent (it can be more than the
  limit when spent is negative), `over` is spent minus limit. The percent is spent × 100 / limit rounded to a whole
  number, a half rounded up toward the larger number (`12.5` → `13`, `-12.5` → `-12`). No budget lines: no output.
- `ledge import <csv-file> --account <account> [--rules <file>] [--default <account>]` imports a bank's CSV file into
  `--account` (which is required, and given once). See below.

### The budget file
One line per limit: `<account> <amount> <currency>`, separated by whitespace. Blank lines and comment lines (`#`) are
skipped. A limit must be more than `0.00`. The account need not be declared in the journal. A wrong line, or a second
line for the same account and currency, is an error (exit 4) naming the budget file and `line N`.

## CSV
ledge writes CSV with a header row `date,payee,account,amount,currency`, then one row per posting. A field that
contains a comma, a double quote or a line break is wrapped in double quotes, with each double quote inside doubled;
every other field is written as it is. Every row ends with `\n`. With no posting, the CSV is just the header row.

    date,payee,account,amount,currency
    2024-01-05,"Shop, the corner",Expenses:Food,42.10,USD

When ledge reads CSV, a field may be wrapped in double quotes, and then it may hold commas, doubled double quotes and
line breaks. Rows end with LF or CRLF; blank lines are skipped. A quote that is never closed, or text after a closing
quote before the next comma or line end, is an error.

### Importing
- The CSV's first row is its header. It must have the columns `date`, `payee`, `amount` and `currency` (exactly these
  names, in any order; other columns are ignored). Every other row is one bank line: a real date, a payee that is not
  empty and has no line break, an amount and a currency, as in the journal; each field is used without the whitespace
  at its ends. A missing column, a row with a different number of fields than the header, or a wrong value is an error
  (exit 4) naming the CSV file and `line N`, the line the row starts on (the header is line 1).
- The amount is the change of `--account`: `-42.10` is money going out.
- The rules file (`--rules`) maps payees to accounts: one rule per line, `<account> <text>`, where the text is the rest
  of the line without whitespace at either end. Blank and comment (`#`) lines are skipped. A line without text or with
  a malformed account is an error (exit 4). A row's other account is the account of the first rule whose text the
  payee contains, ignoring the case of `A`–`Z`; with no matching rule, the `--default` account, or `Expenses:Unknown`
  without `--default`.
- Each row becomes a transaction on its date, with its payee and two postings: `--account` with the amount, then the
  other account with the amount's sign turned over, in the row's currency.
- A row is a duplicate, and is skipped, when the journal already has a transaction on the same date with the same
  payee and a posting to `--account` of the same amount and currency. Rows are checked in file order, each against the
  journal with the rows imported before it, so a row repeated in the file is imported once.
- `--account`, and every other account that a row that is not a duplicate would use, must be declared in the journal
  (exit 5, the first one in row order, `--account` first). Nothing is written then.
- The new transactions are added in the CSV's row order, and ledge prints `imported N, skipped M` (M duplicates).

## How ledge writes the journal
ledge only ever adds to the end of the journal; what is already there is never changed. If the file does not end with
a line break, ledge first adds one. Before a transaction it adds a blank line, unless the file is empty or its last
line is already blank. An `account` line is added with no blank line before it. ledge writes LF line endings. A
transaction is written as its date line `<date> <payee>`, then one line per posting: four spaces, the account, two
spaces, the amount, one space, the currency. Every posting is written with its amount.

    2024-01-05 Corner Shop
        Expenses:Food  42.10 USD
        Assets:Checking  -42.10 USD

## Using it from Node
Importing the package gives these functions. An amount is a whole number of cents (`4210` is `42.10`).

- `parseAmount(text)` → the cents, or throws an `Error` for text that is not an amount.
- `formatAmount(cents)` → the text, as ledge prints it.
- `parseJournal(text, name)` → `{ accounts, transactions }` for one journal text named `name` (used in error
  messages; default `journal`). `accounts` are the declared names in reading order. A transaction is
  `{ line, date, payee, postings }`, and a posting `{ account, amount, currency }`, with an inferred amount filled
  in. `include` is not followed here: an `include` line is an error. On an error it throws an `Error` whose message
  contains `line N` and whose `line` property is N.
- `loadJournal(file)` → the same for a journal file, following its includes; a missing file is an empty journal.
- `balance(journal, options)` → `{ rows: [{ account, currency, amount }], totals: [{ currency, amount }] }`, in the
  printed order. `options` are `{ account, from, to, payee, currency, depth, sort }`, each optional; `account` is a list.
- `register(journal, options)` → `[{ date, payee, account, amount, currency, running }]`, in the printed order, with
  the options of `balance` but `depth`.
- `parseCsv(text)` → the rows, each a list of strings, blank lines skipped; throws on bad quoting.
- `toCsv(rows)` → the CSV text of a list of rows (each a list of strings), quoted as above, each row ending with `\n`.
