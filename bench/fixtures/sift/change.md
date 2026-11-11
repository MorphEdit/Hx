# sift 2: decimal division, softer errors and unions

I have used the first version for a while. A few things it does are not what I want, and I need a few things it does
not do. Everything in the first brief still holds, except what this page changes. Where this page says "was", that is
the old rule, which no longer holds.

## What changes

### Dividing two integers gives a decimal
- `/` with two integers now gives a decimal: the exact quotient rounded to 6 digits after the point, a half going away
  from zero, like decimal `/`. `7 / 2` is `3.5`, `-7 / 2` is `-3.5`, `6 / 3` is `2.0`, `1 / 3` is `0.333333`,
  `2 / 3` is `0.666667`, `-2 / 3` is `-0.666667`.
- Its type is `decimal`, before anything runs too: so `CASE WHEN … THEN 7 / 2 ELSE 'x' END` is still a type error,
  `CAST(7 / 2 AS INTEGER)` is `3`, `7 / 2 % 2` is a type error (`%` takes integers), and `SUM(a / b)` of integers is
  a decimal. `INSERT`ing `7 / 2` into an `integer` column is a type error (exit 5).
- Was: integer `/` dropped the remainder, rounding toward zero (`7 / 2` was `3`) and gave an integer.
- `+`, `-`, `*` and `%` of two integers still give an integer.

### Dividing by zero gives NULL
- `x / 0` and `x % 0` now give NULL, for integers and decimals alike (`1 / 0`, `1.5 / 0.0`, `7 % 0` are all NULL),
  and the statement goes on. So `SELECT 1 / 0` prints `NULL` in the table format, and `UPDATE t SET a = 1 / 0` sets
  NULL.
- Was: dividing by zero was a run-time error (exit 6).
- Every other run-time error is unchanged.

### NULLs sort last
- In `ORDER BY`, NULL now comes after every other value: **last when ascending, first when descending.** `NULLS FIRST`
  and `NULLS LAST` still put them first or last whatever the direction.
- Was: NULL came before every other value (first when ascending, last when descending).
- Only `ORDER BY` changes: `MIN` and `MAX` still skip NULLs, and comparisons with NULL still give NULL.

### LIKE ignores case
- `LIKE` and `NOT LIKE` now ignore the case of the letters `A`–`Z` and `a`–`z`: `'Apple' LIKE 'a%'` is `TRUE`,
  `'APPLE' LIKE '%pp%'` is `TRUE`. Every other character still stands for itself exactly, and `%` and `_` keep their
  meaning.
- Was: case mattered (`'Apple' LIKE 'a%'` was `FALSE`).
- `=`, `<>`, the ordering of texts, `DISTINCT`, `GROUP BY`, `UNION`, `INSTR` and `REPLACE` still compare texts exactly,
  case included.

### Numbers are right-aligned in the table format
- In the `table` format, a column whose type is `integer` or `decimal` is now padded on the left instead of the
  right, its name in the header line included; every other column (text, boolean, date, or a bare `NULL` with no type)
  stays padded on the right. The width rule, the line under the header, `NULL` and `(N rows)` are unchanged, and every
  line still loses its spaces at the end.

      id | name        | price
      ---+-------------+------
       1 | apple       |   1.5
       2 | pear, green |  0.25
       3 |             |  12.0
       4 | NULL        |  NULL
      (4 rows)

- Was: every column was padded on the right.
- The `csv` and `json` formats are unchanged.

## What is new

### UNION and UNION ALL
- `SELECT … UNION ALL SELECT …` gives the rows of the first `SELECT`, then those of the second, in their orders.
  `UNION` does the same and then keeps only the first of every set of equal rows (NULL equal to NULL, as for
  `DISTINCT`). A chain is worked out left to right: `a UNION ALL b UNION c` is `(a UNION ALL b) UNION c`.
- Every `SELECT` of a union gives the same number of columns (exit 5 otherwise). The columns at the same position must
  have one type, or be a mix of integers and decimals (the column is then a decimal and the integers become decimals),
  with a bare `NULL` allowed anywhere; otherwise exit 5. The result's column names are the first `SELECT`'s.
- `ORDER BY`, `LIMIT` and `OFFSET` written after the last `SELECT` apply to the whole union. Its `ORDER BY` items may
  only be result column names (of the first `SELECT`) or positions (exit 5 otherwise). A `SELECT` of a union other
  than the last cannot have `ORDER BY` or `LIMIT`: it is a syntax error at that `ORDER` or `LIMIT`. Each `SELECT` of a
  union may otherwise have every clause, `DISTINCT`, `WHERE` and `GROUP BY` included.
- A union may be used wherever a `SELECT` may: alone, as a subquery (scalar or `IN`) and in `INSERT … SELECT`.
- Its subqueries are run as any statement's (once, before it, in the order they start in the text), and its
  `SELECT`s are worked out one after the other, from the first.
- `UNION` and `ALL` were already reserved words.

### IF EXISTS and IF NOT EXISTS
- `CREATE TABLE IF NOT EXISTS t (…)` does what `CREATE TABLE t (…)` does when `t` does not exist. When it does, it
  does nothing, does not read `t.csv`, and prints `skipped t`. (Two columns of the same name are still exit 5 either
  way.)
- `DROP TABLE IF EXISTS t` does what `DROP TABLE t` does when `t` exists. When it does not, it does nothing and prints
  `skipped t`.
- Without `IF EXISTS` / `IF NOT EXISTS`, both behave as before (exit 4). In a script, "exists" means what the
  statements before it left. `IF` and `EXISTS` were already reserved words.

### The markdown format
- `--format markdown` prints a `SELECT`'s rows as a Markdown table, and `format(result, 'markdown')` in the library
  returns the same text:

      | id | name | price | in_stock |
      | ---: | --- | ---: | --- |
      | 1 | apple | 1.5 | true |
      | 3 |  | 12.0 | NULL |

- The first line is `| `, the column names joined by ` | `, and ` |`. The second has one cell per column: `---:` for a
  column whose type is `integer` or `decimal`, `---` for any other, built the same way. Then one line per row, built
  the same way from the printed values. Nothing is padded. Every line ends with `\n`, and there is no `(N rows)` line.
- In a cell, NULL is `NULL`, every `|` in a text is written `\|`, every `\r\n` and every `\n` or `\r` left is written
  `<br>`. Values are otherwise printed as in the other formats. The empty text is an empty cell (`|  |` in the line).
- With no rows: the two first lines only.
- Other statements print their one line whatever the format, as before. `markdown` is a value `--format` accepts
  everywhere `table`, `csv` and `json` are; any other value is still a usage error (exit 1).
