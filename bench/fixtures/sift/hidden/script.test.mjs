// sift run: a script all or nothing, parsed first, each statement seeing the ones before it, its output in order.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMERS, change, dbFiles, fails, lines, ok, read, script, sift, syntaxAt, workdir } from './helpers.mjs';

const T = lines('a:integer', '1');

describe('sift run', { concurrency: true }, () => {
  test('statements run in order and their outputs follow each other', async () => {
    const r = await script('CREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1), (2);\nSELECT a FROM t;\n', { format: 'csv' });
    ok(r, 'created t', 'inserted 2', 'a', '1', '2');
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer', '1', '2'));
  });

  test('the last ; is optional', async () => {
    ok(await script('SELECT 1 AS x; SELECT 2 AS y', { format: 'csv' }), 'x', '1', 'y', '2');
  });

  test('each statement prints exactly as sift query would, in the table format by default', async () => {
    ok(await script("SELECT 'a' AS s; SELECT 'b' AS s WHERE FALSE"), 's', '-', 'a', '(1 row)', 's', '-', '(0 rows)');
  });

  test('a statement that fails writes nothing at all and prints only the error', async () => {
    const r = await script("INSERT INTO t VALUES (2);\nSELECT a FROM t;\nINSERT INTO t VALUES (CAST('x' AS INTEGER));\n", { tables: { t: T }, format: 'csv' });
    fails(r, 6);
    assert.equal(read(r.dir, 'db/t.csv'), T);
  });

  test('a failed script creates and deletes nothing', async () => {
    const r = await script('CREATE TABLE n (a INTEGER); DROP TABLE t; SELECT nope FROM n;', { tables: { t: T } });
    fails(r, 5);
    assert.deepEqual(dbFiles(r.dir), ['t.csv']);
    assert.equal(read(r.dir, 'db/t.csv'), T);
  });

  test('a syntax error anywhere means nothing runs', async () => {
    const r = await script('INSERT INTO t VALUES (2);\nSELECT 1;\nSELECT # FROM t;\n', { tables: { t: T } });
    syntaxAt(r, 3, 8);
    assert.equal(read(r.dir, 'db/t.csv'), T);
  });

  test('a syntax error is placed in the whole script', async () => {
    syntaxAt(await script('SELECT 1;\r\n-- two\r\nSELECT 1 +;'), 3, 11);
  });

  test('a syntax error wins over a failing first statement', async () => {
    syntaxAt(await script('SELECT * FROM missing; SELECT (;'), 1, 32);
  });

  test('an empty statement is a syntax error at the second ;', async () => {
    syntaxAt(await script('SELECT 1;;SELECT 2'), 1, 10);
    syntaxAt(await script('SELECT 1;\n  ;'), 2, 3);
  });

  test('a script with no statement prints nothing and succeeds', async () => {
    ok(await script(''));
    ok(await script('-- nothing here\n/* at all */\n'));
  });

  test('each statement sees what the ones before it changed', async () => {
    ok(await script("UPDATE t SET a = 5; INSERT INTO t SELECT a + 1 FROM t; SELECT SUM(a) FROM t; DELETE FROM t WHERE a = 5; SELECT a FROM t",
      { tables: { t: T }, format: 'csv' }), 'updated 1', 'inserted 1', 'col1', '11', 'deleted 1', 'a', '6');
  });

  test('a table changed several times is written once with its final rows', async () => {
    const r = await script('INSERT INTO t VALUES (2); UPDATE t SET a = a * 10; DELETE FROM t WHERE a = 10;', { tables: { t: T } });
    ok(r, 'inserted 1', 'updated 2', 'deleted 1');
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer', '20'));
    assert.deepEqual(dbFiles(r.dir), ['t.csv']);
  });

  test('a table created and dropped by the script is never written', async () => {
    const r = await script('CREATE TABLE tmp (a INTEGER); INSERT INTO tmp VALUES (1); SELECT COUNT(*) FROM tmp; DROP TABLE tmp;', { format: 'csv' });
    ok(r, 'created tmp', 'inserted 1', 'col1', '1', 'dropped tmp');
    assert.deepEqual(dbFiles(r.dir), []);
  });

  test('a table dropped and created again is written with its new header', async () => {
    const r = await script("DROP TABLE t; CREATE TABLE t (b TEXT); INSERT INTO t VALUES ('x');", { tables: { t: T } });
    ok(r, 'dropped t', 'created t', 'inserted 1');
    assert.equal(read(r.dir, 'db/t.csv'), lines('b:text', 'x'));
  });

  test('a table is what the statements before left: one dropped earlier is exit 4', async () => {
    const r = await script('DROP TABLE t; SELECT * FROM t;', { tables: { t: T } });
    fails(r, 4);
    assert.equal(read(r.dir, 'db/t.csv'), T);
  });

  test('a table created earlier in the script exists for the next statements', async () => {
    fails(await script('CREATE TABLE t (a INTEGER); CREATE TABLE t (a INTEGER);'), 4);
    ok(await script('SELECT 1 AS x; CREATE TABLE u (a INTEGER); SELECT COUNT(*) AS n FROM u', { format: 'csv' }), 'x', '1', 'created u', 'n', '0');
  });

  test('a failing statement is reported before anything wrong with a later one', async () => {
    fails(await script("INSERT INTO t VALUES (CAST('x' AS INTEGER)); SELECT nope FROM t;", { tables: { t: T } }), 6);
    fails(await script('SELECT nope FROM t; SELECT * FROM missing;', { tables: { t: T } }), 5);
    fails(await script("SELECT * FROM missing; SELECT CAST('x' AS INTEGER);"), 4);
  });

  test('a script that only reads writes nothing', async () => {
    const r = await script('SELECT * FROM t; SELECT 1;', { tables: { t: 'A:INTEGER\r\n1' }, format: 'csv' });
    ok(r, 'a', '1', 'col1', '1');
    assert.equal(read(r.dir, 'db/t.csv'), 'A:INTEGER\r\n1');
  });

  test('tables a script does not change are not touched', async () => {
    const r = await script('INSERT INTO t SELECT id FROM customers WHERE id = 4;', { tables: { t: T, customers: CUSTOMERS.replace(/\n/g, '\r\n') } });
    ok(r, 'inserted 1');
    assert.equal(read(r.dir, 'db/customers.csv'), CUSTOMERS.replace(/\n/g, '\r\n'));
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer', '1', '4'));
  });

  test('the script is read as UTF-8, relative to the current folder', async () => {
    const dir = workdir({ files: { 'sql/go.sql': "SELECT 'héllo ✓' AS s" } });
    ok(await sift(['run', 'sql/go.sql', '--format', 'csv'], { dir }), 's', 'héllo ✓');
  });

  test('a script with \\r\\n line breaks and comments between statements', async () => {
    ok(await script('-- start\r\nSELECT 1 AS a; /* mid */\r\nSELECT 2 AS b -- end\r\n', { format: 'csv' }), 'a', '1', 'b', '2');
  });

  test('two statements on one line', async () => ok(await script("SELECT 'x' AS a;SELECT 'y' AS b", { format: 'json' }),
    '{"columns":["a"],"rows":[["x"]]}', '{"columns":["b"],"rows":[["y"]]}'));

  test('a script with a broken table file fails with exit 4 and its line', async () => {
    const r = await script('SELECT 1; SELECT * FROM t;', { tables: { t: lines('a:integer', 'x') } });
    fails(r, 4);
    assert.match(r.stderr, /t\.csv/);
    assert.match(r.stderr, /\bline 2\b/);
  });

  change('IF NOT EXISTS in a script sees the tables the statements before it left', async () => {
    const r = await script('CREATE TABLE t (a INTEGER); CREATE TABLE IF NOT EXISTS t (b TEXT); INSERT INTO t VALUES (1);');
    ok(r, 'created t', 'skipped t', 'inserted 1');
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer', '1'));
  });

  change('DROP TABLE IF EXISTS in a script after the table was dropped', async () => {
    const r = await script('DROP TABLE t; DROP TABLE IF EXISTS t; CREATE TABLE IF NOT EXISTS t (c DATE);', { tables: { t: T } });
    ok(r, 'dropped t', 'skipped t', 'created t');
    assert.equal(read(r.dir, 'db/t.csv'), lines('c:date'));
  });

  change('a division by zero in a script goes on', async () => {
    const r = await script('INSERT INTO t VALUES (1 % 0); SELECT COUNT(*), COUNT(a) FROM t;', { tables: { t: T }, format: 'csv' });
    ok(r, 'inserted 1', 'col1,col2', '2,1');
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer', '1', ''));
  });

  change('run with --format markdown prints every SELECT as markdown', async () => {
    ok(await script("SELECT 1 AS n; INSERT INTO t VALUES (2); SELECT a, 'x' AS s FROM t", { tables: { t: T }, format: 'markdown' }),
      '| n |', '| ---: |', '| 1 |', 'inserted 1', '| a | s |', '| ---: | --- |', '| 1 | x |', '| 2 | x |');
  });

  change('a union in a script', async () => {
    ok(await script('INSERT INTO t SELECT 2 UNION SELECT 2; SELECT a FROM t', { tables: { t: T }, format: 'csv' }), 'inserted 1', 'a', '1', '2');
  });
});
