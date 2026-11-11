// The library: query, run, format, tables and SiftError, as the brief's "Using it from Node" states them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FRUIT, change, dbPath, lines, loadLib, localToday, read, workdir } from './helpers.mjs';

const fruitDb = () => dbPath(workdir({ tables: { fruit: FRUIT } }));
const opts = (db) => ({ db, today: '2024-03-15' });
// a call that throws or returns a rejected promise: the brief does not say whether the library is synchronous
const thrown = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail('it did not throw');
};

describe('the library', { concurrency: true }, () => {
  test('query of a SELECT returns columns, types and rows of typed values', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT * FROM fruit', opts(fruitDb()));
    assert.deepEqual(r.columns, ['id', 'name', 'price', 'in_stock', 'added']);
    assert.deepEqual(r.types, ['integer', 'text', 'decimal', 'boolean', 'date']);
    assert.deepEqual(r.rows, [
      [1n, 'apple', '1.5', true, '2024-01-05'],
      [2n, 'pear, green', '0.25', false, null],
      [3n, '', '12.0', true, '2023-12-31'],
      [4n, null, null, null, null],
    ]);
  });

  test('a bare NULL column has the type null, and integers are bigints however large', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT NULL AS n, 9223372036854775807 AS big, -9223372036854775807 - 1 AS small, 1 + 0.5', opts(fruitDb()));
    assert.deepEqual(r.columns, ['n', 'big', 'small', 'col4']);
    assert.deepEqual(r.types, [null, 'integer', 'integer', 'decimal']);
    assert.deepEqual(r.rows, [[null, 9223372036854775807n, -9223372036854775808n, '1.5']]);
  });

  test('query of another statement returns its message and changes the file', async () => {
    const lib = await loadLib();
    const db = fruitDb();
    assert.deepEqual(await lib.query("INSERT INTO fruit (id, name) VALUES (5, 'fig'), (6, 'kiwi')", opts(db)), { message: 'inserted 2' });
    assert.ok(read(path.dirname(db), 'db/fruit.csv').endsWith('5,fig,,,\n6,kiwi,,,\n'));
    assert.deepEqual(await lib.query('CREATE TABLE z (a INTEGER)', opts(db)), { message: 'created z' });
  });

  test('query takes today from its options', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT TODAY()', { db: fruitDb(), today: '2020-02-29' });
    assert.deepEqual(r.rows, [['2020-02-29']]);
    assert.deepEqual(r.types, ['date']);
  });

  test('query without today uses the local date, never the environment', async () => {
    const lib = await loadLib();
    const saved = { db: process.env.SIFT_DB, today: process.env.SIFT_TODAY };
    process.env.SIFT_TODAY = '1999-01-01';
    process.env.SIFT_DB = 'nowhere-at-all';
    try {
      const before = localToday();
      const r = await lib.query('SELECT TODAY()', { db: fruitDb() });
      assert.ok([before, localToday()].includes(r.rows[0][0]), String(r.rows[0][0]));
    } finally {
      for (const [k, name] of [['db', 'SIFT_DB'], ['today', 'SIFT_TODAY']]) {
        if (saved[k] === undefined) delete process.env[name];
        else process.env[name] = saved[k];
      }
    }
  });

  test('run returns the result of every statement, in order', async () => {
    const lib = await loadLib();
    const db = fruitDb();
    const rs = await lib.run("CREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1), (2);\nSELECT a FROM t WHERE a > 1;", opts(db));
    assert.equal(rs.length, 3);
    assert.deepEqual(rs[0], { message: 'created t' });
    assert.deepEqual(rs[1], { message: 'inserted 2' });
    assert.deepEqual([rs[2].columns, rs[2].types, rs[2].rows], [['a'], ['integer'], [[2n]]]);
    assert.equal(read(path.dirname(db), 'db/t.csv'), lines('a:integer', '1', '2'));
  });

  test('run of a script with no statement returns an empty list', async () => {
    const lib = await loadLib();
    assert.deepEqual(await lib.run('-- nothing\n', opts(fruitDb())), []);
  });

  test('run is all or nothing: a failing statement throws and writes nothing', async () => {
    const lib = await loadLib();
    const db = fruitDb();
    const e = await thrown(() => lib.run("DELETE FROM fruit; SELECT CAST('x' AS INTEGER);", opts(db)));
    assert.ok(e instanceof lib.SiftError);
    assert.equal(e.exitCode, 6);
    assert.equal(read(path.dirname(db), 'db/fruit.csv'), FRUIT);
  });

  test('format prints a result as the CLI does', async () => {
    const lib = await loadLib();
    const r = await lib.query("SELECT name, added FROM fruit WHERE id < 3", opts(fruitDb()));
    assert.equal(lib.format(r, 'csv'), 'name,added\napple,2024-01-05\n"pear, green",\n');
    assert.equal(lib.format(r, 'json'), '{"columns":["name","added"],"rows":[["apple","2024-01-05"],["pear, green",null]]}\n');
    assert.equal(lib.format(r, 'table'), 'name        | added\n------------+-----------\napple       | 2024-01-05\npear, green | NULL\n(2 rows)\n');
  });

  test('format of a message result is the message and a line break', async () => {
    const lib = await loadLib();
    for (const name of ['table', 'csv', 'json']) assert.equal(lib.format({ message: 'deleted 3' }, name), 'deleted 3\n');
  });

  test('tables returns the table names, sorted, without reading them', async () => {
    const lib = await loadLib();
    const dir = workdir({ tables: { zeta: lines('a:integer'), alpha: '"broken\n' }, files: { 'db/Notes.csv': 'x\n', 'db/readme.txt': 'x\n' } });
    assert.deepEqual(await lib.tables(dbPath(dir)), ['alpha', 'zeta']);
  });

  test('a syntax error throws a SiftError with exit code 3, line and column', async () => {
    const lib = await loadLib();
    const e = await thrown(() => lib.query('SELECT 1,\n  #', opts(fruitDb())));
    assert.ok(e instanceof lib.SiftError);
    assert.equal(e.exitCode, 3);
    assert.equal(e.line, 2);
    assert.equal(e.column, 3);
    assert.match(e.message, /^syntax error at line 2, column 3: /);
  });

  test('a table file error throws with exit code 4, its file and line', async () => {
    const lib = await loadLib();
    const db = dbPath(workdir({ tables: { bad: lines('a:integer', '1', 'nope') } }));
    const e = await thrown(() => lib.query('SELECT * FROM bad', opts(db)));
    assert.equal(e.exitCode, 4);
    assert.equal(e.file, 'bad.csv');
    assert.equal(e.line, 3);
    assert.match(e.message, /bad\.csv/);
    assert.doesNotMatch(e.message, /^error: /);
  });

  test('a missing table, a check error and a run-time error throw with exit codes 4, 5 and 6', async () => {
    const lib = await loadLib();
    const db = fruitDb();
    assert.equal((await thrown(() => lib.query('SELECT * FROM nope', opts(db)))).exitCode, 4);
    assert.equal((await thrown(() => lib.query('SELECT colour FROM fruit', opts(db)))).exitCode, 5);
    assert.equal((await thrown(() => lib.query("SELECT CAST('x' AS INTEGER)", opts(db)))).exitCode, 6);
  });

  test('a data directory that does not exist throws with exit code 2', async () => {
    const lib = await loadLib();
    const e = await thrown(() => lib.query('SELECT 1', { db: path.join(workdir(), 'missing'), today: '2024-03-15' }));
    assert.ok(e instanceof lib.SiftError);
    assert.equal(e.exitCode, 2);
  });

  test('query takes one statement: a second is a syntax error', async () => {
    const lib = await loadLib();
    const e = await thrown(() => lib.query('SELECT 1; SELECT 2', opts(fruitDb())));
    assert.equal(e.exitCode, 3);
    assert.deepEqual([e.line, e.column], [1, 11]);
  });

  test('the library reads a table changed on disk between calls', async () => {
    const lib = await loadLib();
    const db = fruitDb();
    writeFileSync(path.join(db, 'n.csv'), lines('a:integer', '1'));
    assert.deepEqual((await lib.query('SELECT a FROM n', opts(db))).rows, [[1n]]);
    writeFileSync(path.join(db, 'n.csv'), lines('a:integer', '2'));
    assert.deepEqual((await lib.query('SELECT a FROM n', opts(db))).rows, [[2n]]);
  });

  change('an integer quotient is a decimal string and division by zero null', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT 7 / 2, 6 / 3, 1 / 0', opts(fruitDb()));
    assert.deepEqual(r.types, ['decimal', 'decimal', 'decimal']);
    assert.deepEqual(r.rows, [['3.5', '2.0', null]]);
  });

  change('format markdown', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT id, name FROM fruit WHERE id IN (1, 4)', opts(fruitDb()));
    assert.equal(lib.format(r, 'markdown'), '| id | name |\n| ---: | --- |\n| 1 | apple |\n| 4 | NULL |\n');
    assert.equal(lib.format({ message: 'inserted 1' }, 'markdown'), 'inserted 1\n');
  });

  change('format table right-aligns number columns', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT id, price FROM fruit WHERE id < 3', opts(fruitDb()));
    assert.equal(lib.format(r, 'table'), 'id | price\n---+------\n 1 |   1.5\n 2 |  0.25\n(2 rows)\n');
  });

  change('a union through the library: the integer and decimal column is a decimal', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT 1 AS n UNION ALL SELECT 2.5 ORDER BY n DESC', opts(fruitDb()));
    assert.deepEqual([r.columns, r.types, r.rows], [['n'], ['decimal'], [['2.5'], ['1.0']]]);
  });

  change('IF EXISTS and IF NOT EXISTS through run', async () => {
    const lib = await loadLib();
    const rs = await lib.run('DROP TABLE IF EXISTS nope; CREATE TABLE IF NOT EXISTS fruit (a INTEGER); DROP TABLE IF EXISTS fruit', opts(fruitDb()));
    assert.deepEqual(rs, [{ message: 'skipped nope' }, { message: 'skipped fruit' }, { message: 'dropped fruit' }]);
  });

  change('NULLs sort last through the library', async () => {
    const lib = await loadLib();
    const r = await lib.query('SELECT id FROM fruit ORDER BY added', opts(fruitDb()));
    assert.deepEqual(r.rows, [[3n], [1n], [2n], [4n]]);
  });
});
