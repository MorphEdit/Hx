// Output: the table, csv, json and markdown formats, and how each value is printed.
import { describe, test } from 'node:test';
import { FRUIT, change, csv, ok, query, sift } from './helpers.mjs';

const t = (body) => ({ tables: { t: body } });
const json = (sql, opts = {}) => query(sql, { ...opts, format: 'json' });
const md = (sql, opts = {}) => query(sql, { ...opts, format: 'markdown' });
const FRUIT3 = 'id:integer,name:text,price:decimal\n1,apple,1.5\n2,"pear, green",0.25\n3,"",12\n4,,\n';

describe('the table format', { concurrency: true }, () => {
  test('text columns are padded on the right to their width, joined by " | ", and lose their spaces at the end', async () => {
    ok(await query('SELECT a, b FROM t', t('a:text,b:text\nx,longer\nhello,\n"",q\n')),
      'a     | b', '------+-------', 'x     | longer', 'hello | NULL', '      | q', '(3 rows)');
  });

  test('table is the default format', async () => {
    ok(await sift(['query', "SELECT 'hi' AS greeting"]), 'greeting', '--------', 'hi', '(1 row)');
  });

  test('one row is (1 row)', async () => ok(await query("SELECT 'x' AS a"), 'a', '-', 'x', '(1 row)'));

  test('no rows: the header, the line under it and (0 rows)', async () => {
    ok(await query('SELECT a FROM t WHERE FALSE', t('a:text\nx\n')), 'a', '-', '(0 rows)');
  });

  test('a line break in a text is shown as \\n and \\r, and the width counts what is shown', async () => {
    ok(await query('SELECT s FROM t', t('s:text\n"l1\nl2"\n"cr\r"\n')), 's', '------', 'l1\\nl2', 'cr\\r', '(2 rows)');
  });

  test('widths count UTF-16 code units', async () => {
    ok(await query("SELECT '😀' AS e, 'é' AS f, 'x' AS g"), 'e  | f | g', '---+---+--', '😀 | é | x', '(1 row)');
  });

  test('a bare NULL column is padded on the right', async () => {
    ok(await query("SELECT NULL AS long_name, 'x' AS b"), 'long_name | b', '----------+--', 'NULL      | x', '(1 row)');
  });

  test('boolean and date columns are padded on the right', async () => {
    ok(await query("SELECT TRUE AS flag_column, CAST('2024-01-05' AS DATE) AS d"),
      'flag_column | d', '------------+-----------', 'true        | 2024-01-05', '(1 row)');
  });

  test('a NULL in a text column is NULL, and an empty text is blank', async () => {
    ok(await query('SELECT name FROM t', t('name:text\n""\n\nabc\n')), 'name', '----', '', 'NULL', 'abc', '(3 rows)');
  });

  test('a statement other than SELECT prints its one line in the table format', async () => {
    ok(await query('INSERT INTO t VALUES (1)', t('a:integer\n')), 'inserted 1');
  });

  change('number columns are padded on the left, their header included', async () => {
    ok(await query('SELECT * FROM t', t(FRUIT3)),
      'id | name        | price', '---+-------------+------', ' 1 | apple       |   1.5', ' 2 | pear, green |  0.25', ' 3 |             |  12.0',
      ' 4 | NULL        |  NULL', '(4 rows)');
  });

  change('an integer column right-aligns its header under a wider value', async () => {
    ok(await query('SELECT id AS i FROM t', t('id:integer\n1\n100\n')), '  i', '---', '  1', '100', '(2 rows)');
  });

  change('an integer column right-aligns its values under a wider header', async () => {
    ok(await query('SELECT 1 AS number'), 'number', '------', '     1', '(1 row)');
  });

  change('negative numbers and decimals right-aligned', async () => {
    ok(await query('SELECT -5 AS n, 2.5 AS d'), ' n |   d', '---+----', '-5 | 2.5', '(1 row)');
  });

  change('a number column followed by a text column', async () => {
    ok(await query("SELECT price, name FROM t WHERE id < 3", t(FRUIT3)), 'price | name', '------+------------', '  1.5 | apple', ' 0.25 | pear, green', '(2 rows)');
  });

  change('an integer quotient is a decimal column, right-aligned', async () => {
    ok(await query('SELECT 7 / 2 AS half'), 'half', '----', ' 3.5', '(1 row)');
  });

  change('a division by zero prints NULL', async () => {
    ok(await query('SELECT 1 / 0'), 'col1', '----', 'NULL', '(1 row)');
  });

  test('no rows: every column is as wide as its name', async () => {
    ok(await query('SELECT id AS identifier, 1.5 AS x, name FROM t WHERE FALSE', t(FRUIT3)), 'identifier | x | name', '-----------+---+-----', '(0 rows)');
  });
});

describe('the csv format', { concurrency: true }, () => {
  test('a header row, then one row per result row', async () => {
    ok(await csv('SELECT * FROM fruit', { tables: { fruit: FRUIT } }),
      'id,name,price,in_stock,added', '1,apple,1.5,true,2024-01-05', '2,"pear, green",0.25,false,', '3,"",12.0,true,2023-12-31', '4,,,,');
  });

  test('a value with a comma, a quote, \\r or \\n is quoted; NULL is empty and the empty text ""', async () => {
    ok(await csv('SELECT s FROM t', t('s:text\n"a,b"\n"say ""x"""\n"l1\nl2"\n"cr\r"\n""\n\n')), 's', '"a,b"', '"say ""x"""', '"l1\nl2"', '"cr\r"', '""', '');
  });

  test('other values are written as they are, spaces kept', async () => {
    ok(await csv("SELECT ' a ', 'x;y', 'tab\there'"), 'col1,col2,col3', ' a ,x;y,tab\there');
  });

  test('no rows: just the header row', async () => ok(await csv('SELECT a, b FROM t WHERE FALSE', t('a:integer,b:text\n1,x\n')), 'a,b'));

  test('csv prints numbers as sift prints them', async () => {
    ok(await csv('SELECT 9223372036854775807, -0.000001, 3.0, -0'), 'col1,col2,col3,col4', '9223372036854775807,-0.000001,3.0,0');
  });

  change('csv is not padded, whatever the change does to the table format', async () => {
    ok(await csv('SELECT 1 AS number, 7 / 2 AS half'), 'number,half', '1,3.5');
  });
});

describe('the json format', { concurrency: true }, () => {
  test('one line of columns and rows, numbers as printed, NULL as null', async () => {
    ok(await json('SELECT * FROM fruit', { tables: { fruit: FRUIT } }),
      '{"columns":["id","name","price","in_stock","added"],"rows":[[1,"apple",1.5,true,"2024-01-05"],[2,"pear, green",0.25,false,null],' +
      '[3,"",12.0,true,"2023-12-31"],[4,null,null,null,null]]}');
  });

  test('every digit of a number is kept', async () => {
    ok(await json('SELECT 9223372036854775807, -0.000001, 123456789012345678.5, -9223372036854775807 - 1'),
      '{"columns":["col1","col2","col3","col4"],"rows":[[9223372036854775807,-0.000001,123456789012345678.5,-9223372036854775808]]}');
  });

  test('no rows: "rows":[]', async () => ok(await json('SELECT a FROM t WHERE FALSE', t('a:text\nx\n')), '{"columns":["a"],"rows":[]}'));

  test('texts are written as JSON.stringify writes them', async () => {
    const v = 'q"b\\c\nt\tx\u0001é/\r';
    ok(await json('SELECT s FROM t', t(`s:text\n"${v.replace(/"/g, '""')}"\n`)), `{"columns":["s"],"rows":[[${JSON.stringify(v)}]]}`);
  });

  test('columns of the same name are all kept, and a bare NULL is null', async () => {
    ok(await json('SELECT 1 AS a, 2 AS a, NULL'), '{"columns":["a","a","col3"],"rows":[[1,2,null]]}');
  });

  test('a statement other than SELECT prints its one line in json', async () => {
    ok(await json('INSERT INTO t VALUES (1), (2)', t('a:integer\n')), 'inserted 2');
  });

  change('an integer quotient is a decimal in json', async () => {
    ok(await json('SELECT 6 / 3, 1 / 0'), '{"columns":["col1","col2"],"rows":[[2.0,null]]}');
  });
});

describe('the markdown format', { concurrency: true }, () => {
  change('a Markdown table: right-aligned marks for numbers, then one line per row', async () => {
    ok(await md('SELECT * FROM t', t('id:integer,name:text,price:decimal,in_stock:boolean\n1,apple,1.5,true\n3,"",12,\n')),
      '| id | name | price | in_stock |', '| ---: | --- | ---: | --- |', '| 1 | apple | 1.5 | true |', '| 3 |  | 12.0 | NULL |');
  });

  change('markdown with no rows is the two first lines only', async () => {
    ok(await md('SELECT id, name FROM t WHERE FALSE', t(FRUIT3)), '| id | name |', '| ---: | --- |');
  });

  change('markdown writes | as \\| and every line break as <br>', async () => {
    ok(await md('SELECT s FROM t', t('s:text\n"a|b"\n"x\r\ny"\n"p\n\rq"\n"\r\n\n"\n\n')),
      '| s |', '| --- |', '| a\\|b |', '| x<br>y |', '| p<br><br>q |', '| <br><br> |', '| NULL |');
  });

  change('markdown marks dates, booleans and bare NULLs with ---', async () => {
    ok(await md("SELECT CAST('2024-01-05' AS DATE) AS d, TRUE AS b, NULL AS n, 1.5 AS x, -3 AS y"),
      '| d | b | n | x | y |', '| --- | --- | --- | ---: | ---: |', '| 2024-01-05 | true | NULL | 1.5 | -3 |');
  });

  change('markdown pads nothing and prints values as the other formats do', async () => {
    ok(await md('SELECT name, price FROM t WHERE id < 3', t(FRUIT3)), '| name | price |', '| --- | ---: |', '| apple | 1.5 |', '| pear, green | 0.25 |');
  });

  change('markdown keeps duplicate column names and col<n>', async () => {
    ok(await md('SELECT 1 AS a, 2 AS a, 3 + 4'), '| a | a | col3 |', '| ---: | ---: | ---: |', '| 1 | 2 | 7 |');
  });

  change('a statement other than SELECT prints its one line in markdown', async () => {
    ok(await md('INSERT INTO t VALUES (1)', t('a:integer\n')), 'inserted 1');
    ok(await md('CREATE TABLE u (a INTEGER)'), 'created u');
  });

  change('markdown of an integer quotient is a number column', async () => {
    ok(await md('SELECT 7 / 2 AS q'), '| q |', '| ---: |', '| 3.5 |');
  });
});
