# sift

I want `sift`, a Node tool that runs SQL over a folder of CSV files: a command-line program and a library I can
import. No dependencies, plain Node.js. Each CSV file is one table, and its header row says the name and the type of
each column. sift reads them, answers `SELECT` queries with joins, groups and subqueries, and changes them with
`INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE` and `DROP TABLE`, so I can keep small databases as files I can open and
fix by hand.

## The data directory
- The data directory is the folder named by the `SIFT_DB` environment variable, relative to the current folder. When
  `SIFT_DB` is not set or is empty, every command but a usage error fails with exit 2. When it does not name an
  existing directory, every command fails with exit 2 too. sift never creates or deletes the data directory itself.
- A **table** is a file directly in the data directory whose name is `<name>.csv`, where `<name>` is made of the
  lower-case letters `a`–`z`, the digits and `_`, does not start with a digit and is not a reserved word (below).
  Every other file or folder in the data directory (other names, capital letters, subfolders, files starting with `.`)
  is not a table: sift never reads, changes or deletes it. sift finds tables by listing the directory, so the file
  name must match exactly, whatever the file system thinks of capital letters.
- "Today" is the `SIFT_TODAY` environment variable, a date written `YYYY-MM-DD` (e.g. `SIFT_TODAY=2024-03-15`); if
  it is not set, the computer's local date. If it is set but is not a real date, every command fails with exit 2,
  even one that does not use today. Only the `TODAY()` function reads it.
- sift reads a table only when a statement names it. A broken table file that no statement names is never an error.

## Table files
A table file is CSV, read as UTF-8 (a byte-order mark at the very start is skipped). Its first row is the header,
every other row is one row of the table.

    id:integer,name:text,price:decimal,in_stock:boolean,added:date
    1,apple,1.5,true,2024-01-05
    2,"pear, green",0.25,false,
    3,"",12,true,2023-12-31

### Reading CSV
- Fields are separated by commas. A field may be wrapped in double quotes; then it may hold commas, line breaks and
  doubled double quotes (`""` is one `"`). A line break inside quotes is kept exactly as written (`\r\n` stays
  `\r\n`). A quote that is never closed is an error, and so is anything after a closing quote other than a comma or
  the end of the row. A field that does not start with `"` must not contain one.
- Rows end with `\n` or `\r\n`. The last row may end without one. Every line is a row, also an empty one: an empty
  line is a row with one empty field (so in a table of one column it is a row holding NULL, and in a wider table it is
  a row with the wrong number of fields). A line break at the very end of the file does not start another row.
- The **header** has at least one field, and every field is exactly `<column>:<type>`, with no spaces. The column is
  an identifier (below), case does not matter and sift turns it to lower case; two columns with the same name are an
  error. The type is one of `integer`, `decimal`, `text`, `boolean` and `date`, in any case. An empty file (no header)
  is an error.
- Every row has exactly as many fields as the header. Each field is read as its column's type:
  - An empty field that is not quoted is NULL, in every column. A quoted empty field (`""`) is the empty text in a
    `text` column and NULL in any other column. Apart from that, quoting a field changes nothing.
  - `integer`: an optional `-`, then one or more digits (`007` is 7), from -9223372036854775808 to
    9223372036854775807.
  - `decimal`: an optional `-`, one or more digits, and optionally a `.` followed by 1 to 6 digits (`5`, `5.25`,
    `-0.000001`); at most 18 digits before the point. `.5`, `5.` and `1e3` are wrong.
  - `text`: the field exactly as it is; spaces are kept.
  - `boolean`: `true` or `false`, in small letters.
  - `date`: `YYYY-MM-DD`, a real date from `0001-01-01` to `9999-12-31` (`2023-02-29` is wrong).
  - Nothing is trimmed: ` 5` in an `integer` column is wrong.
- An error in a table file names the file (at least `<name>.csv`) and contains `line N`, the line the row starts on,
  counting every line of the file from 1 (the header is line 1, and line breaks inside quotes count), e.g.
  `orders.csv line 4: bad integer "12x"`. The first error in the file is the one reported; the rest of the wording is
  up to you.

### How sift writes a table file
When a statement changes a table, sift writes the whole file again, in its own form, whatever the file looked like
before:
- The header is `<column>:<type>` for every column, in order, both in small letters, joined by commas.
- Then one line per row, in the table's row order. Every line, the header included, ends with `\n`.
- A NULL is an empty field. The empty text is `""`. Any other value is written as sift prints it (below: `5.0` for a
  decimal 5, `true`, `2024-01-05`), wrapped in double quotes (with every `"` inside doubled) when it contains a comma,
  a `"`, `\r` or `\n`; otherwise it is written as it is.
- A file is written atomically: sift writes the new content to a temporary file in the data directory whose name
  starts with `.sift-`, then renames it over the table's file. No temporary file is left behind when sift exits,
  whether it succeeded or not.
- A statement that changes no row (an `UPDATE` or `DELETE` whose `WHERE` selects no row, an `INSERT … SELECT` of no
  rows) does not touch the file. Files of tables that a statement does not change are never touched.

## The language
sift reads statements written in a subset of SQL.

### Words, literals and comments
- Whitespace is spaces, tabs, `\r` and `\n`. `-- …` is a comment to the end of the line, and `/* … */` is a comment
  that may span lines (not nested; one that is never closed is a syntax error).
- **Reserved words** are, in any case: `ALL`, `AND`, `AS`, `ASC`, `BETWEEN`, `BY`, `CASE`, `CAST`, `CREATE`, `DELETE`,
  `DESC`, `DISTINCT`, `DROP`, `ELSE`, `END`, `EXISTS`, `FALSE`, `FROM`, `GROUP`, `HAVING`, `IF`, `IN`, `INNER`,
  `INSERT`, `INTO`, `IS`, `JOIN`, `LEFT`, `LIKE`, `LIMIT`, `NOT`, `NULL`, `NULLS`, `OFFSET`, `ON`, `OR`, `ORDER`,
  `OUTER`, `SELECT`, `SET`, `TABLE`, `THEN`, `TRUE`, `UNION`, `UPDATE`, `VALUES`, `WHEN`, `WHERE`. (`ALL`, `EXISTS`,
  `IF` and `UNION` are reserved although this version does not use them.) The type names (`INTEGER`, `DECIMAL`,
  `TEXT`, `BOOLEAN`, `DATE`), `FIRST`, `LAST` and the function names are not reserved.
- An **identifier** (a table, column or alias name) is a letter or `_` followed by letters, digits and `_`, letters
  being `A`–`Z` and `a`–`z`, and is not a reserved word. Identifiers are not case-sensitive: sift turns them to lower
  case when it reads them, and shows them in lower case. There are no quoted identifiers.
- An **integer literal** is one or more digits; outside the integer range it is a syntax error. A **decimal literal**
  is digits, `.`, and 1 to 6 digits (`0.5`, `12.25`); more than 6 digits after the point, more than 18 before it, or
  a point with no digit on one side is a syntax error. There are no exponents and no signed literals: `-5` is the minus
  operator applied to `5`.
- A **text literal** is written in single quotes, with `''` for one `'`. It may span lines. One that is never closed
  is a syntax error at its opening quote.
- `TRUE`, `FALSE` and `NULL` are literals.
- The other symbols are `+ - * / % || = <> != < <= > >= ( ) , . ;`. Any other character outside a literal or a
  comment is a syntax error at that character.

### Syntax errors
A syntax error is reported as `syntax error at line L, column C: <what was wrong>`, where the wording after the colon
is up to you. Lines count from 1 and end at `\n` (`\r\n` is one line break; a `\r` alone is whitespace). Columns count
characters from 1, a tab is one column. The position is the start of the token where the error was found; for an
unclosed text literal or comment, its first character; at the end of the input, the position just after the last
character (when the text ends with `\n`, that is column 1 of the next line). The first syntax error in the text is the
one reported.

### Statements

    SELECT [DISTINCT] <item>, …
      [FROM <table> [[AS] <alias>] [<join> …]]
      [WHERE <condition>]
      [GROUP BY <expression>, …]
      [HAVING <condition>]
      [ORDER BY <expression> [ASC | DESC] [NULLS FIRST | NULLS LAST], …]
      [LIMIT <integer> [OFFSET <integer>]]

    <item>  is  *  |  <table or alias>.*  |  <expression> [[AS] <alias>]
    <join>  is  [INNER] JOIN <table> [[AS] <alias>] ON <condition>
            |   LEFT [OUTER] JOIN <table> [[AS] <alias>] ON <condition>

    INSERT INTO <table> [(<column>, …)] VALUES (<expression>, …), …
    INSERT INTO <table> [(<column>, …)] SELECT …
    UPDATE <table> SET <column> = <expression>, … [WHERE <condition>]
    DELETE FROM <table> [WHERE <condition>]
    CREATE TABLE <table> (<column> <type>, …)
    DROP TABLE <table>

- The clauses come in the order shown. `LIMIT` and `OFFSET` take integer literals only. `FROM a, b` is a syntax
  error: tables are combined with `JOIN` only. A `SELECT` without `FROM` gives one row.
- A statement may end with one `;`. `sift query` takes exactly one statement; a second one is a syntax error at its
  first token. In a script (`sift run`), statements are separated by `;`, the last `;` is optional, and there must be
  a statement between two `;` (an empty one is a syntax error at the second `;`).
- `CREATE TABLE` has at least one column; its types are the five type names, in any case.

### Expressions
From the loosest to the tightest binding:

1. `OR`
2. `AND`
3. `NOT` (prefix)
4. comparisons: `=`, `<>`, `!=` (the same as `<>`), `<`, `<=`, `>`, `>=`, `IS [NOT] NULL`, `[NOT] IN (<list>)`,
   `[NOT] IN (<select>)`, `[NOT] LIKE`, `[NOT] BETWEEN <a> AND <b>`. They do not chain: `a < b < c` is a syntax
   error at the second `<`.
5. `+`, `-` and `||`, left to right
6. `*`, `/` and `%`, left to right
7. `-` (prefix minus)
8. literals, column references (`<column>` or `<table or alias>.<column>`), function calls (`<name>(<args>)`,
   `COUNT(*)`), `CAST(<expression> AS <type>)`, `CASE`, `(<expression>)` and `(<select>)`, a scalar subquery.

So `NOT a = b` is `NOT (a = b)`, `-a * b` is `(-a) * b`, and `a + b || c` is `(a + b) || c`. An `IN` list has at
least one expression.

## Types and values
A value is an **integer** (from -9223372036854775808 to 9223372036854775807), a **decimal** (an exact decimal number
with at most 6 digits after the point and less than 10^18 in size), a **text**, a **boolean**, a **date**
(`0001-01-01` to `9999-12-31`), or **NULL**. Every expression has a type that sift knows before it runs the
statement: a column has its column's type, a literal its own, and the operators and functions below say theirs. The
`NULL` literal has no type of its own and is accepted wherever a value of any type is. "A number" is an integer or a
decimal. A type that an operator or function does not accept is a **type error** (exit 5), found before anything runs,
whatever the data holds.

### Operators
- `+`, `-`, `*`, `/`, `%` take numbers. Two integers give an integer; when either side is a decimal, the integer side
  becomes a decimal and the result is a decimal.
  - Integer `/` divides and drops the remainder (rounds toward zero): `7 / 2` is `3`, `-7 / 2` is `-3`.
  - `%` takes integers only (a decimal is a type error). Its result has the sign of the left side: `7 % 3` is `1`,
    `-7 % 3` is `-1`, `7 % -3` is `1`.
  - Decimal `+` and `-` are exact. Decimal `*` and `/` are worked out exactly and then rounded to 6 digits after the
    point, a half going away from zero (`1.0 / 3` is `0.333333`, `2.0 / 3` is `0.666667`, `0.000005 * 0.1` is
    `0.000001`, `-0.000005 * 0.1` is `-0.000001`).
  - Dividing by zero (`/` or `%`, integers or decimals) is a run-time error (exit 6).
  - An integer result outside the integer range, or a decimal result of 10^18 or more in size, is a run-time error
    (exit 6).
- Dates: `<date> + <integer>`, `<integer> + <date>` and `<date> - <integer>` give the date that many days later or
  earlier; `<date> - <date>` gives the integer number of days from the right one to the left one
  (`CAST('2024-03-01' AS DATE) - CAST('2024-02-01' AS DATE)` is `29`).
  A date outside the date range is a run-time error (exit 6). No other operator takes a date but the comparisons.
- `-` (prefix) takes a number.
- `||` joins two texts. A side that is not a text is turned into text first, as `CAST(… AS TEXT)` does.
- Comparisons (`=`, `<>`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`) compare two values of the same type, or two numbers
  (an integer and a decimal compare by their value), or a text and a date: the text is turned into a date first, and a
  text that is not a date is a run-time error (exit 6). When either side is NULL, the comparison is NULL and nothing is
  turned into a date (`CAST(NULL AS DATE) = 'soon'` is NULL, not an error). Any other pair is a type error.
  `a BETWEEN b AND c` is
  `a >= b AND a <= c`; `a IN (x, y)` compares `a` with each item.
- `LIKE` takes two texts. In the pattern, `%` stands for any run of characters (none included) and `_` for exactly
  one; every other character stands for itself, and case matters. The pattern must match the whole text. There is no
  escape character.
- `AND`, `OR` and `NOT` take booleans, and so do `WHERE`, `HAVING`, `ON` and `CASE WHEN`: any other type there is a
  type error.

### Comparing and sorting values
Numbers by value; texts character by character by their character codes (UTF-16 code units, as JavaScript's `<`
compares strings), so `B` comes before `a` and `ab` before `b`; `false` before `true`; dates by time.

### NULL
- Every operator above gives NULL when either side is NULL, except `AND`, `OR`, `IS NULL`, `IN` and `BETWEEN`
  (which is worked out as its `AND`: `5 BETWEEN NULL AND 3` is `FALSE`).
- `AND`, `OR` and `NOT` use three-valued logic: `NULL AND FALSE` is `FALSE`, `NULL AND TRUE` is NULL, `NULL OR TRUE`
  is `TRUE`, `NULL OR FALSE` is NULL, `NOT NULL` is NULL.
- `x IS NULL` and `x IS NOT NULL` are `TRUE` or `FALSE`, never NULL.
- `a IN (…)` is `TRUE` when `a` equals an item; otherwise NULL when `a` or any item is NULL; otherwise `FALSE`.
  `NOT IN` is the `NOT` of that, so `1 NOT IN (2, NULL)` is NULL. The same holds for `IN (<select>)` over the
  subquery's values.
- `WHERE`, `HAVING` and `ON` keep a row only when the condition is `TRUE`: NULL counts as not kept. A `CASE WHEN`
  whose condition is NULL is not taken.
- For `DISTINCT` and `GROUP BY`, NULL equals NULL: all NULLs are one group.
- In `ORDER BY`, NULL comes before every other value: first when ascending, last when descending. `NULLS FIRST` and
  `NULLS LAST` put the NULLs first or last whatever the direction.

### Casts
`CAST(<expression> AS <type>)` turns a value into another type; the type is one of the five type names, in any case.
NULL becomes NULL of that type. Turning a value into
its own type keeps it. The others:
- to `text`: any value, as sift prints it (below).
- to `integer`: a decimal loses its digits after the point (rounds toward zero: `-2.7` is `-2`); `true` is 1 and
  `false` is 0; a text must be exactly an integer as in a table file (an optional `-` and digits, no spaces) in the
  integer range, or it is a run-time error (exit 6). A date is a type error.
- to `decimal`: an integer (outside the decimal range a run-time error); a text written as a table file's decimal, or
  it is a run-time error (exit 6). A boolean or a date is a type error.
- to `boolean`: the integer 0 is `false` and any other integer is `true`; a text must be exactly `true` or `false`, or
  it is a run-time error (exit 6). A decimal or a date is a type error.
- to `date`: a text written `YYYY-MM-DD` that is a real date in range, or it is a run-time error (exit 6). Any other
  type is a type error.

### Assigning a value to a column
A value stored by `INSERT` or `UPDATE` must have the column's type, with two exceptions: an integer goes into a
`decimal` column as that decimal (outside the decimal range a run-time error), and a text goes into a `date` column as
a cast to `date` does (a text that is not a date is a run-time error). NULL goes into any column. Any other type is a
type error.

## Queries

### Names
- A table in `FROM` or `JOIN` is known in the query by its alias when it has one, otherwise by its name. Two tables
  known by the same name in one `FROM` (a self-join without aliases, or two equal aliases) are an error (exit 5).
- `<column>` alone names the column of that name among all the query's tables; when more than one has it, it is
  ambiguous (exit 5); when none has it, exit 5. `<t>.<column>` names the column of the table known as `<t>`. A name
  that matches nothing is an error (exit 5).
- In a `JOIN … ON`, the condition may name the tables joined so far and the one being joined, not those joined after
  it.
- A subquery sees only its own tables: it cannot name a column of the query around it. A name of the outer query is
  "no such column" inside it.
- Aliases of `SELECT` items can be used in `ORDER BY` only. In `ORDER BY`, a name alone that is the alias of a
  `SELECT` item means that item, even when a table also has a column of that name; two items with that alias make it
  ambiguous (exit 5). An `ORDER BY` item that is just an integer literal `n` means the n-th `SELECT` item (counting
  `*` as all the columns it gives); `0` or more than the number of items is exit 5.

### Results
- `*` gives every column of every table of the query, the tables in `FROM` order, each table's columns in their
  order; `<t>.*` gives the columns of `<t>`. `*` without `FROM` is exit 5.
- The name of a result column is its alias when it has one; else, for a column reference, the column's name; else
  `col<n>`, where `n` is its position among the result's columns, counting from 1 (`SELECT COUNT(*) FROM t` gives one
  column named `col1`, and `SELECT a, 1 + 2 FROM t` gives `a` and `col2`). Two result columns may have the same name.
- The type of a result column is its expression's type (none for a bare `NULL`).

### Joins
- An inner join of a row `L` with a table `R` gives one row per row of `R` for which the `ON` condition is `TRUE`.
- A left join gives the same, and for an `L` with no such row, one row with every column of `R` NULL.
- Joins are made left to right: `a JOIN b ON … LEFT JOIN c ON …` joins `a` with `b`, then that result with `c`.

### Grouping and aggregates
- The aggregates are `COUNT(*)`, `COUNT(<expression>)`, `SUM`, `AVG`, `MIN` and `MAX`, each with one argument.
  - `COUNT(*)` counts the rows; `COUNT(x)` counts the rows where `x` is not NULL. Both give an integer, `0` for no
    rows, never NULL.
  - `SUM(x)` takes a number and adds up the values that are not NULL: an integer for integers (outside the range a
    run-time error), a decimal for decimals. NULL when there is no such value.
  - `AVG(x)` takes a number and gives a decimal: the exact sum of the values that are not NULL divided by their
    count, rounded to 6 digits after the point, a half going away from zero (`AVG` of 1, 2 and 2 is `1.666667`). NULL
    when there is no such value.
  - `MIN(x)` and `MAX(x)` take any type and give the smallest or largest value that is not NULL, in the order above,
    with the argument's type. NULL when there is no such value.
  - An aggregate over the `NULL` literal gives NULL (`COUNT(NULL)` gives `0`).
- A query is **grouped** when it has `GROUP BY` or `HAVING`, or an aggregate in its `SELECT` items or `ORDER BY`.
  Without `GROUP BY`, a grouped query has exactly one group holding all its rows, so it gives exactly one row, even
  with no rows (`SELECT COUNT(*) FROM t WHERE FALSE` gives `0`).
- In a grouped query, every column reference in the `SELECT` items, `HAVING` and `ORDER BY` that is not inside an
  aggregate must be inside an expression that is the same as a `GROUP BY` item (the same once case and spacing are
  ignored), e.g. `GROUP BY YEAR(added)` allows `SELECT YEAR(added)`. Otherwise it is exit 5. `*` in a grouped query is
  the same error unless every column it gives is a `GROUP BY` item.
- An aggregate is exit 5 in `WHERE`, `ON`, `GROUP BY`, inside another aggregate, in a query that is not a `SELECT`
  (`INSERT … VALUES`, `UPDATE`, `DELETE`), and in `ORDER BY` of a query with `DISTINCT` unless it is the same as a
  `SELECT` item.
- `GROUP BY` items are expressions over the tables' columns; aliases and positions are not allowed there (an alias is
  just a name that is not a column, exit 5).

### DISTINCT, ORDER BY, LIMIT
- `DISTINCT` keeps the first of every set of equal result rows.
- With `DISTINCT`, every `ORDER BY` item must be a result column (by alias or position) or the same expression as a
  `SELECT` item; otherwise exit 5.
- `ORDER BY` sorts by its items in turn, each ascending unless `DESC`, NULLs as above. The sort is stable: rows that
  are equal on every item keep their order.
- `LIMIT n` keeps the first `n` rows, after skipping `OFFSET m` rows. `LIMIT 0` keeps none; an `OFFSET` past the end
  keeps none.

### Row order
A query without `ORDER BY` gives its rows in this order, and `ORDER BY` sorts this order stably:
- One table: the rows in their file order.
- A join: for each row of the left side in its order, the rows of the right table that match, in their file order
  (and for a left join without a match, the row with NULLs in that place).
- `WHERE` keeps the order. A grouped query gives its groups in the order of each group's first row (after `WHERE`).
  `DISTINCT` keeps the first of each set of equal rows where it was.

### Subqueries
- `(<select>)` as a value is a scalar subquery: it must give exactly one column (exit 5 otherwise), and its value is
  the value in its one row, or NULL when it gives no rows. More than one row is a run-time error (exit 6).
- `x IN (<select>)` takes a subquery of exactly one column (exit 5 otherwise), compared with `x` as a list.
- A subquery may have every clause of a `SELECT`, `ORDER BY` and `LIMIT` included.

### When things are worked out
This decides which run-time error is met first, and whether one is met at all:
- Every subquery is run once, before the statement that holds it, in the order the subqueries start in the text (a
  subquery's own subqueries first, by the same rule).
- Then, in this order: the joins (each `ON` for each pair, in the join order above); `WHERE` for each row, in order;
  the `GROUP BY` items for each row; the aggregates; `HAVING` for each group, in group order; the `SELECT` items for
  each row (or group) in order, left to right, then that row's `ORDER BY` items, left to right; then `DISTINCT`,
  `ORDER BY` and `LIMIT`. A row that `WHERE` drops never has its `SELECT` items worked out, and a group that
  `HAVING` drops never has its `SELECT` items or `ORDER BY` items worked out. `LIMIT` cuts rows only after they are
  all worked out, so an error in a row that `LIMIT` would drop is still an error.
- Inside an expression, operands and function arguments are worked out left to right. `AND` stops after its left
  side when that is `FALSE`, `OR` when that is `TRUE`. `CASE` works out its conditions in order, stops at the first
  that is `TRUE` (or, for `CASE <value>`, at the first `<v>` equal to the value), and works out only the result it
  picks. `COALESCE` stops at its first argument that is not NULL. `a IN (x, y, …)` works out `a` and then every
  item, left to right, before it compares.
- `UPDATE` and `DELETE` work through the table's rows in file order; `INSERT … VALUES` through its rows in order,
  each left to right. `UPDATE` works out a row's new values only when its `WHERE` keeps the row.

## Functions and CASE
Function names are not case-sensitive. An unknown function, a wrong number of arguments or an argument of a type the
function does not take is exit 5. Below, `t`, `s`, `from` and `to` stand for texts, `n` for a number and `d` for a date
(but `ROUND`'s `d` is an integer), and `start` and `length` are integers; a function takes only those types and turns
nothing into them (`LENGTH(123)`, `ABS('1')` and `YEAR('2024-01-01')` are type errors). Unless it says otherwise, a
function gives NULL when any argument is NULL.

Text:
- `LENGTH(t)`: the number of characters (UTF-16 code units, as JavaScript counts them), an integer.
- `UPPER(t)`, `LOWER(t)`: only the letters `a`–`z` and `A`–`Z` change.
- `TRIM(t)`: the text without spaces (` ` only) at either end.
- `SUBSTR(t, start)`, `SUBSTR(t, start, length)`: the characters from position `start` (1 is the first), at most
  `length` of them. A `start` past the end gives `''`. A `start` below 1 or a `length` below 0 is a run-time error
  (exit 6). `start` and `length` are integers.
- `REPLACE(t, from, to)`: every occurrence of `from`, left to right and not overlapping, replaced by `to`. An empty
  `from` gives `t` unchanged.
- `INSTR(t, s)`: the position of the first occurrence of `s` in `t` (1 is the first character), `0` when there is
  none, `1` when `s` is empty.

Numbers:
- `ABS(n)`: the size of `n`, with its type (the smallest integer has no positive twin: a run-time error).
- `ROUND(n)`, `ROUND(n, d)`: `n` rounded to `d` digits after the point (`0` when left out), a half going away from
  zero. `d` is an integer from 0 to 6, or it is a run-time error (exit 6). An integer `n` is returned as it is; a
  decimal stays a decimal (`ROUND(2.5)` is `3.0`, `ROUND(-2.45, 1)` is `-2.5`).
- `FLOOR(n)`, `CEIL(n)`: the integer at or below, or at or above, `n`.

Dates:
- `TODAY()`: today's date (above).
- `YEAR(d)`, `MONTH(d)`, `DAY(d)`: integers.
- `WEEKDAY(d)`: an integer from 1 for Monday to 7 for Sunday.
- `ADD_MONTHS(d, n)`: the date `n` months later (earlier for a negative `n`), on the same day of the month, or the last
  day of that month when it is shorter (`ADD_MONTHS(CAST('2024-01-31' AS DATE), 1)` is `2024-02-29`). Outside the
  date range a run-time error. `n` is an integer.

Others:
- `COALESCE(a, b, …)`, two arguments or more: the first that is not NULL, NULL when all are.
- `NULLIF(a, b)`: NULL when `a = b` is `TRUE`, otherwise `a`. `a` and `b` must be comparable.
- `CASE WHEN <condition> THEN <result> … [ELSE <result>] END`: the result of the first condition that is `TRUE`;
  `CASE <value> WHEN <v> THEN <result> … [ELSE <result>] END`: the result of the first `<v>` with `<value> = <v>`
  `TRUE` (so a NULL value matches nothing). Without `ELSE`, NULL when nothing matches. Each `<v>` must be comparable
  with `<value>`.
- `COALESCE` and `CASE` results must all have one type, or be a mix of integers and decimals (the result is then a
  decimal), with `NULL` allowed anywhere; otherwise exit 5.

## Changing tables
- `INSERT INTO t (c1, c2) VALUES (…), (…)` adds rows at the end of the table, in order. Each named column must exist
  and be named once (exit 5). Without a column list, every column in order. Every row has as many values as there are
  columns (exit 5); the columns not named get NULL. The values are expressions without column references (a column
  name is "no such column", exit 5); subqueries are allowed. Each value is assigned as above. It prints
  `inserted N`.
- `INSERT INTO t … SELECT …` adds the rows of the `SELECT`, in its order. The `SELECT` must give as many columns as
  there are to fill (exit 5), each assignable to its column by its type. The `SELECT` reads the tables as they were
  before the insert, even `t` itself.
- `UPDATE t SET c = e, … [WHERE …]` changes the rows the condition keeps (all rows without `WHERE`). Each column is
  set once at most (exit 5). Every `e` sees the row as it was before this statement. Rows keep their place. It prints
  `updated N`, the number of rows the condition kept.
- `DELETE FROM t [WHERE …]` removes the rows the condition keeps (all rows without `WHERE`). The other rows keep their
  order. It prints `deleted N`.
- `CREATE TABLE t (c type, …)` creates `t.csv` with just its header. A table that already exists is exit 4; two
  columns of the same name are exit 5. It prints `created t`.
- `DROP TABLE t` deletes `t.csv` without reading it. A table that does not exist is exit 4. It prints `dropped t`.
- There are no keys or other constraints.

## The command line

    sift query <sql> [--format table|csv|json]
    sift run <script.sql> [--format table|csv|json]
    sift tables
    sift schema <table>

- `sift query <sql>` runs one statement and prints its output.
- `sift run <script.sql>` runs a script file (relative to the current folder, read as UTF-8) **all or nothing**: the
  whole script is parsed first, so a syntax error anywhere means nothing runs. Then the statements run in order, each
  one seeing what the ones before it changed. Only when every statement has succeeded does sift write the tables that
  changed (each once, with its final rows; a table created and then dropped by the script is never written). When a
  statement fails, nothing at all is written and nothing is printed but the error. A script with no statement prints
  nothing and succeeds. The output is each statement's output in order, exactly as `sift query` would print it, with
  nothing between them.
- `sift tables` prints the table names, sorted by their character codes (so `a_b` comes before `ab`), one per line,
  without reading the files. No tables: no output.
- `sift schema <table>` reads the table's file and prints one line `<column> <type>` per column, in order, the type in
  small letters. The table is given as an identifier (any case); something else is a usage error.
- `--format` (`table` by default) decides how a `SELECT`'s rows are printed. Other statements print their one line
  (`inserted 2`, `created t`, …) whatever the format.
- Options come after the command, in any order and mixed with its arguments; `--format` takes the next argument as its
  value. An argument made only of `--` followed by one or more of the letters `a`–`z` and `-` is an option; any other
  argument is not (so a query starting with `-- comment` is an argument). `tables` and `schema` take no option.

### Output
Every line of output ends with `\n`. Results go to stdout. An error is one line on stderr starting with `error: `
(a syntax error's line is `error: syntax error at line L, column C: …`), and then stdout is empty and no file is
created, changed or deleted. An error is always a message and an exit code, never an uncaught exception.

How a value is printed, in every format and when cast to text:
- an integer: its digits, with `-` when negative (`-0` is `0`);
- a decimal: its digits with `-` when negative, the digits before the point without leading zeros (`0` when there are
  none), a `.`, and the digits after the point without trailing zeros but at least one: `2.5`, `3.0`, `0.125`,
  `-0.5`. Zero is `0.0`, never `-0.0`;
- a text as it is; a boolean `true` or `false`; a date `YYYY-MM-DD`;
- NULL depends on the format.

**`table`** (the default):

    id | name        | price
    ---+-------------+------
    1  | apple       | 1.5
    2  | pear, green | 0.25
    3  |             | 12.0
    4  | NULL        | NULL
    (4 rows)

- Each column is as wide as the longest of its name and its printed values, counted in characters (UTF-16 code
  units). NULL is printed `NULL`. In a text, every `\n` is shown as the two characters `\n` and every `\r` as `\r`,
  and the width counts what is shown.
- The header line is the column names and each row line the printed values, each padded on the right with spaces to
  its column's width, joined by ` | `. The line under the header is, for each column, `-` repeated its width, joined
  by `-+-`. Every line then loses its spaces at the end.
- Then `(N rows)`, or `(1 row)` for one row. With no rows: the header, the line under it and `(0 rows)`.

**`csv`**: a header row of the column names, then one row per result row, every row ending with `\n`. NULL is an empty
field, the empty text is `""`, and every value is written as it is printed, wrapped in double quotes (with every `"`
inside doubled) when it contains a comma, a `"`, `\r` or `\n`. With no rows, just the header row.

**`json`**: one line, `{"columns":[…],"rows":[[…],…]}` and `\n`, with no spaces outside strings. `columns` holds the
column names as strings and `rows` one array of values per row. An integer or a decimal is a JSON number written
exactly as printed (`12`, `3.0`, `-0.5`, all digits kept, however long); a text and a date are JSON strings, written
as JavaScript's `JSON.stringify` writes a string; a boolean is `true` or `false`; NULL is `null`. With no rows,
`"rows":[]`.

### Exit codes, and which error wins
When several things are wrong, the first one in this list is reported, with its exit code:

1. **Usage, exit 1:** no command, an unknown command, a missing or extra argument, an unknown option, an option the
   command does not take, an option given twice, an option without its value, a `--format` value that is not one of
   the formats, a table name for `schema` that is not an identifier. Nothing else is looked at before these.
2. **Environment, exit 2:** in this order, `SIFT_TODAY` set but not a real date; `SIFT_DB` not set or empty;
   `SIFT_DB` not an existing directory; for `run`, a script file that does not exist or cannot be read.
3. **Syntax, exit 3:** the first syntax error in the statement or the whole script.

Then each statement in turn, in a script in order (so a failing first statement is reported before anything wrong
with the second, which is never looked at), goes through:

4. **Tables, exit 4:** a table the statement names (in `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`,
   `CREATE TABLE`, `DROP TABLE` or the `schema` command, its subqueries included) that does not exist (for
   `CREATE TABLE`: that already exists), or whose file has an error. The tables are taken in the order their names
   first appear in the statement's text, and each one is checked for existence, then for its file. In a script, a
   table is what the statements before it left.
5. **Checks, exit 5:** what is wrong with the statement against the tables' columns and types: unknown or ambiguous
   names, type errors, wrong use of aggregates and grouping, unknown functions and wrong arguments, wrong column or
   value counts. All found before the statement runs; when there are several, which one is reported is up to you.
6. **Run-time, exit 6:** an error met while the statement runs (dividing by zero, a cast or a conversion that fails,
   a number or a date out of range, a scalar subquery with more than one row, a bad `SUBSTR` or `ROUND` argument).
   The first one met, in the order things are worked out (above), is reported.

Exit `0` is success. For errors other than syntax errors and table file errors, the wording after `error: ` is up
to you.

## Using it from Node
Importing the package (its `main` is `src/sift.js`) gives these. The library never reads the environment: the data
directory and today are given as options.

- `query(sql, options)` runs one statement, like `sift query`. `options` is `{ db, today }`: `db` the data directory
  (required), `today` a `YYYY-MM-DD` date (the local date when left out). For a `SELECT` it returns
  `{ columns, types, rows }`: the result's column names, their types (`'integer'`, `'decimal'`, `'text'`,
  `'boolean'`, `'date'`, or `null` for a bare `NULL`), and the rows as arrays of values. A value is a `bigint` for an
  integer, a string as printed for a decimal (`'3.0'`) or a date, a string for a text, a boolean for a boolean, `null`
  for NULL. For any other statement it returns `{ message }`, the line the CLI prints (`'inserted 2'`).
- `run(script, options)` runs a script's text all or nothing, like `sift run`, and returns the list of the
  statements' results, in order.
- `format(result, name)` returns the text `sift` prints for a result of `query`, `name` being `'table'`, `'csv'` or
  `'json'` (for a `{ message }` result, the message and `\n`).
- `tables(db)` returns the table names, sorted, like `sift tables`.
- On an error these throw a `SiftError` (also exported), whose `exitCode` is the CLI's exit code for it (2 to 6) and
  whose `message` is the text after `error: `. A syntax error also has `line` and `column`; a table file error has
  `file` (the file's name, `<name>.csv`) and `line`.
