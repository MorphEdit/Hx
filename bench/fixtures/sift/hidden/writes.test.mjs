// Writes: INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE, the file sift writes, atomic writes, untouched files.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMERS, change, csv, dbFiles, fails, lines, ok, query, read } from './helpers.mjs';

// a table file in a form sift would not write: capitals, \r\n, a quoted integer, no line break at the end
const LOOSE = 'ID:INTEGER,Name:Text\r\n"1",a\r\n2,b';
const loose = { tables: { t: LOOSE } };
const cust = { tables: { customers: CUSTOMERS } };
const file = (r, name = 't') => read(r.dir, `db/${name}.csv`);
const noTemp = (r) => assert.deepEqual(dbFiles(r.dir).filter((f) => f.startsWith('.sift-')), [], 'no temporary file is left');

describe('INSERT', { concurrency: true }, () => {
  test('INSERT VALUES adds rows at the end and writes the whole file in sift\'s form', async () => {
    const r = await query("INSERT INTO t VALUES (3, 'c'), (4, NULL)", loose);
    ok(r, 'inserted 2');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', '3,c', '4,'));
  });

  test('the columns not named get NULL', async () => {
    const r = await query("INSERT INTO t (name) VALUES ('z')", loose);
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', ',z'));
  });

  test('named columns may come in any order', async () => {
    const r = await query("INSERT INTO t (name, id) VALUES ('z', 9)", loose);
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', '9,z'));
  });

  test('values are written as sift prints them, quoted when they must be', async () => {
    const tables = { t: lines('a:decimal,b:text,c:boolean,d:date,e:integer') };
    const r = await query("INSERT INTO t VALUES (5, '', TRUE, '2024-02-29', -0), (NULL, 'x,y', FALSE, NULL, 7), (0.10, 'say \"hi\"', NULL, NULL, NULL), " +
      "(1.5, 'l1\nl2', NULL, NULL, NULL), (2, 'cr\r', NULL, NULL, NULL), (3, '  sp ', NULL, NULL, NULL)", { tables });
    ok(r, 'inserted 6');
    assert.equal(file(r), 'a:decimal,b:text,c:boolean,d:date,e:integer\n5.0,"",true,2024-02-29,0\n,"x,y",false,,7\n0.1,"say ""hi""",,,\n' +
      '1.5,"l1\nl2",,,\n2.0,"cr\r",,,\n3.0,  sp ,,,\n');
  });

  test('a column named twice is exit 5', async () => fails(await query('INSERT INTO t (id, id) VALUES (1, 2)', loose), 5));

  test('an unknown column is exit 5', async () => fails(await query('INSERT INTO t (nope) VALUES (1)', loose), 5));

  test('a row with the wrong number of values is exit 5', async () => {
    fails(await query('INSERT INTO t VALUES (1)', loose), 5);
    fails(await query("INSERT INTO t (id) VALUES (1, 'a')", loose), 5);
    fails(await query("INSERT INTO t VALUES (1, 'a'), (2)", loose), 5);
  });

  test('a value may not name a column', async () => fails(await query('INSERT INTO t (id) VALUES (id)', loose), 5));

  test('a value of another type is exit 5', async () => {
    fails(await query("INSERT INTO t (id) VALUES ('1')", loose), 5);
    fails(await query('INSERT INTO t (name) VALUES (1)', loose), 5);
    fails(await query('INSERT INTO t (id) VALUES (TRUE)', loose), 5);
    fails(await query('INSERT INTO t (id) VALUES (1.0)', loose), 5);
  });

  test('an integer goes into a decimal column as a decimal', async () => {
    const r = await query('INSERT INTO t VALUES (5)', { tables: { t: lines('a:decimal') } });
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('a:decimal', '5.0'));
  });

  test('an integer too large for a decimal column is a run-time error', async () => {
    fails(await query('INSERT INTO t VALUES (9223372036854775807)', { tables: { t: lines('a:decimal') } }), 6);
  });

  test('a text goes into a date column as a cast does', async () => {
    const tables = { t: lines('d:date') };
    const r = await query("INSERT INTO t VALUES ('2024-02-29')", { tables });
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('d:date', '2024-02-29'));
    fails(await query("INSERT INTO t VALUES ('2023-02-29')", { tables }), 6);
  });

  test('a run-time error in a later row writes nothing', async () => {
    const r = await query("INSERT INTO t VALUES (3, 'c'), (CAST('x' AS INTEGER), 'd')", loose);
    fails(r, 6);
    assert.equal(file(r), LOOSE);
    noTemp(r);
  });

  test('an aggregate in VALUES is exit 5', async () => fails(await query('INSERT INTO t (id) VALUES (COUNT(*))', loose), 5));

  test('a value may be a subquery', async () => {
    const r = await query("INSERT INTO t VALUES ((SELECT MAX(id) FROM t) + 1, 'n')", loose);
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', '3,n'));
  });

  test('INSERT … SELECT adds the rows of the SELECT in its order', async () => {
    const r = await query('INSERT INTO t (name, id) SELECT name, id + 10 FROM customers WHERE id > 2 ORDER BY id DESC', { tables: { t: LOOSE, customers: CUSTOMERS } });
    ok(r, 'inserted 2');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', '14,Dee', '13,Cy'));
  });

  test('INSERT … SELECT reads the table as it was before the insert', async () => {
    const r = await query('INSERT INTO t SELECT id + 2, name FROM t', loose);
    ok(r, 'inserted 2');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', '3,a', '4,b'));
  });

  test('INSERT … SELECT assigns an integer to a decimal column', async () => {
    const r = await query('INSERT INTO d SELECT id FROM customers WHERE id = 1', { tables: { d: lines('a:decimal'), customers: CUSTOMERS } });
    ok(r, 'inserted 1');
    assert.equal(file(r, 'd'), lines('a:decimal', '1.0'));
  });

  test('INSERT … SELECT must give as many columns as there are to fill, of assignable types', async () => {
    fails(await query('INSERT INTO t SELECT id FROM t', loose), 5);
    fails(await query('INSERT INTO t SELECT name, id FROM t', loose), 5);
  });

  test('an INSERT … SELECT of no rows prints inserted 0 and does not touch the file', async () => {
    const r = await query('INSERT INTO t SELECT * FROM t WHERE FALSE', loose);
    ok(r, 'inserted 0');
    assert.equal(file(r), LOOSE);
  });

  test('INSERT names the table in any case', async () => {
    const r = await query("INSERT INTO T VALUES (3, 'c')", loose);
    ok(r, 'inserted 1');
  });

  test('INSERT into a missing table is exit 4, into a broken one exit 4 with its line', async () => {
    fails(await query('INSERT INTO nope VALUES (1)', loose), 4);
    const r = await query('INSERT INTO t VALUES (1)', { tables: { t: lines('a:integer', '1', 'x') } });
    fails(r, 4);
    assert.match(r.stderr, /t\.csv/);
    assert.match(r.stderr, /\bline 3\b/);
  });

  change('INSERT of an integer quotient into an integer column is a type error', async () => {
    fails(await query("INSERT INTO t VALUES (7 / 2, 'x')", loose), 5);
  });

  change('INSERT of an integer quotient into a decimal column stores the decimal', async () => {
    const r = await query('INSERT INTO t VALUES (7 / 2), (1 / 3)', { tables: { t: lines('a:decimal') } });
    ok(r, 'inserted 2');
    assert.equal(file(r), lines('a:decimal', '3.5', '0.333333'));
  });

  change('INSERT of a division by zero stores NULL', async () => {
    const r = await query("INSERT INTO t VALUES (7 % 0, 'z')", loose);
    ok(r, 'inserted 1');
    assert.equal(file(r), lines('id:integer,name:text', '1,a', '2,b', ',z'));
  });
});

describe('UPDATE and DELETE', { concurrency: true }, () => {
  test('UPDATE changes the rows WHERE keeps, which keep their place', async () => {
    const r = await query("UPDATE customers SET city = 'Bergen' WHERE city = 'Oslo'", cust);
    ok(r, 'updated 2');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '1,Ann,Bergen', '2,Bob,Rome', '3,Cy,', '4,Dee,Bergen'));
  });

  test('UPDATE without WHERE changes every row', async () => {
    const r = await query('UPDATE customers SET city = NULL', cust);
    ok(r, 'updated 4');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '1,Ann,', '2,Bob,', '3,Cy,', '4,Dee,'));
  });

  test('every UPDATE expression sees the row as it was', async () => {
    const r = await query('UPDATE t SET a = b, b = a', { tables: { t: lines('a:integer,b:integer', '1,2', '3,4') } });
    ok(r, 'updated 2');
    assert.equal(file(r), lines('a:integer,b:integer', '2,1', '4,3'));
  });

  test('UPDATE with an expression over the row', async () => {
    const r = await query("UPDATE customers SET name = name || '!' , id = id * 10 WHERE id < 3", cust);
    ok(r, 'updated 2');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '10,Ann!,Oslo', '20,Bob!,Rome', '3,Cy,', '4,Dee,Oslo'));
  });

  test('UPDATE whose WHERE keeps no row prints updated 0 and does not touch the file', async () => {
    const r = await query("UPDATE t SET name = 'q' WHERE id > 5", loose);
    ok(r, 'updated 0');
    assert.equal(file(r), LOOSE);
  });

  test('UPDATE drops a row whose condition is NULL', async () => {
    const r = await query("UPDATE customers SET name = 'x' WHERE city <> 'Rome'", cust);
    ok(r, 'updated 2');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '1,x,Oslo', '2,Bob,Rome', '3,Cy,', '4,x,Oslo'));
  });

  test('UPDATE sets a column once at most', async () => fails(await query('UPDATE t SET id = 1, id = 2', loose), 5));

  test('UPDATE of an unknown column, or of a value of another type, is exit 5', async () => {
    fails(await query('UPDATE t SET nope = 1', loose), 5);
    fails(await query("UPDATE t SET id = 'x'", loose), 5);
  });

  test('UPDATE with an aggregate is exit 5', async () => fails(await query('UPDATE t SET id = MAX(id)', loose), 5));

  test('UPDATE with a subquery', async () => {
    const r = await query('UPDATE t SET id = (SELECT MAX(id) FROM t) + id', loose);
    ok(r, 'updated 2');
    assert.equal(file(r), lines('id:integer,name:text', '3,a', '4,b'));
  });

  test('a run-time error in UPDATE writes nothing', async () => {
    const r = await query("UPDATE t SET id = CAST(name AS INTEGER) WHERE id = 2", loose);
    fails(r, 6);
    assert.equal(file(r), LOOSE);
    noTemp(r);
  });

  test('a run-time error in a later row of UPDATE writes nothing, not even the rows before it', async () => {
    const body = lines('a:integer,s:text', '1,5', '2,x');
    const r = await query('UPDATE t SET a = CAST(s AS INTEGER)', { tables: { t: body } });
    fails(r, 6);
    assert.equal(file(r), body);
  });

  test('DELETE removes the rows WHERE keeps; the others keep their order', async () => {
    const r = await query("DELETE FROM customers WHERE city = 'Oslo'", cust);
    ok(r, 'deleted 2');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '2,Bob,Rome', '3,Cy,'));
  });

  test('DELETE without WHERE removes every row and leaves the header', async () => {
    const r = await query('DELETE FROM t', loose);
    ok(r, 'deleted 2');
    assert.equal(file(r), lines('id:integer,name:text'));
  });

  test('DELETE keeps a row whose condition is NULL', async () => {
    const r = await query("DELETE FROM customers WHERE city <> 'Rome'", cust);
    ok(r, 'deleted 2');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '2,Bob,Rome', '3,Cy,'));
  });

  test('DELETE whose WHERE keeps no row prints deleted 0 and does not touch the file', async () => {
    const r = await query('DELETE FROM t WHERE id > 5', loose);
    ok(r, 'deleted 0');
    assert.equal(file(r), LOOSE);
  });

  test('DELETE with an aggregate is exit 5', async () => fails(await query('DELETE FROM t WHERE COUNT(*) > 1', loose), 5));

  change('UPDATE to a division by zero sets NULL', async () => {
    const r = await query('UPDATE t SET id = 1 / 0 WHERE id = 1', { tables: { t: lines('id:decimal,name:text', '1,a', '2,b') } });
    ok(r, 'updated 1');
    assert.equal(file(r), lines('id:decimal,name:text', ',a', '2.0,b'));
  });

  change('UPDATE of an integer column to an integer quotient is a type error', async () => {
    fails(await query('UPDATE t SET id = id / 2', loose), 5);
  });

  change('DELETE where a division by zero is NULL keeps the row', async () => {
    const r = await query('DELETE FROM t WHERE 1 / (id - 1) > 0', loose);
    ok(r, 'deleted 1');
    assert.equal(file(r), lines('id:integer,name:text', '1,a'));
  });

  change('UPDATE WHERE with LIKE ignores case', async () => {
    const r = await query("UPDATE customers SET city = 'X' WHERE name LIKE 'a%'", cust);
    ok(r, 'updated 1');
    assert.equal(file(r, 'customers'), lines('id:integer,name:text,city:text', '1,Ann,X', '2,Bob,Rome', '3,Cy,', '4,Dee,Oslo'));
  });
});

describe('CREATE TABLE and DROP TABLE', { concurrency: true }, () => {
  test('CREATE TABLE writes the header only', async () => {
    const r = await query('CREATE TABLE t (a INTEGER, b text, c Decimal, d BOOLEAN, e date)');
    ok(r, 'created t');
    assert.equal(file(r), lines('a:integer,b:text,c:decimal,d:boolean,e:date'));
  });

  test('CREATE TABLE names the table and its columns in small letters', async () => {
    const r = await query('CREATE TABLE My_Table (Col_A INTEGER)');
    ok(r, 'created my_table');
    assert.deepEqual(dbFiles(r.dir), ['my_table.csv']);
    assert.equal(file(r, 'my_table'), lines('col_a:integer'));
  });

  test('CREATE TABLE of a table that exists is exit 4', async () => {
    const r = await query('CREATE TABLE t (a INTEGER)', loose);
    fails(r, 4);
    assert.equal(file(r), LOOSE);
  });

  test('CREATE TABLE with two columns of the same name is exit 5', async () => {
    const r = await query('CREATE TABLE t (a INTEGER, A TEXT)');
    fails(r, 5);
    assert.deepEqual(dbFiles(r.dir), []);
  });

  test('a created table can be queried', async () => {
    ok(await csv('SELECT * FROM t', { tables: { t: lines('a:integer') } }), 'a');
  });

  test('DROP TABLE deletes the file without reading it', async () => {
    const r = await query('DROP TABLE t', { tables: { t: '"broken\n', u: lines('a:integer') } });
    ok(r, 'dropped t');
    assert.deepEqual(dbFiles(r.dir), ['u.csv']);
  });

  test('DROP TABLE of a missing table is exit 4', async () => fails(await query('DROP TABLE nope'), 4));

  test('a table whose name is a reserved word cannot be created', async () => fails(await query('CREATE TABLE select (a INTEGER)'), 3));

  change('CREATE TABLE IF NOT EXISTS creates a table that does not exist', async () => {
    const r = await query('CREATE TABLE IF NOT EXISTS t (a INTEGER)');
    ok(r, 'created t');
    assert.equal(file(r), lines('a:integer'));
  });

  change('CREATE TABLE IF NOT EXISTS of a table that exists does nothing and prints skipped', async () => {
    const r = await query('CREATE TABLE IF NOT EXISTS t (x TEXT)', loose);
    ok(r, 'skipped t');
    assert.equal(file(r), LOOSE);
  });

  change('CREATE TABLE IF NOT EXISTS does not read the table that exists', async () => {
    const r = await query('CREATE TABLE IF NOT EXISTS t (a INTEGER)', { tables: { t: '"broken\n' } });
    ok(r, 'skipped t');
    assert.equal(file(r), '"broken\n');
  });

  change('CREATE TABLE IF NOT EXISTS with two columns of the same name is still exit 5, either way', async () => {
    fails(await query('CREATE TABLE IF NOT EXISTS t (a INTEGER, a TEXT)', loose), 5);
    fails(await query('CREATE TABLE IF NOT EXISTS t (a INTEGER, a TEXT)'), 5);
  });

  change('DROP TABLE IF EXISTS drops a table that exists', async () => {
    const r = await query('DROP TABLE IF EXISTS t', loose);
    ok(r, 'dropped t');
    assert.deepEqual(dbFiles(r.dir), []);
  });

  change('DROP TABLE IF EXISTS of a missing table does nothing and prints skipped', async () => {
    const r = await query('DROP TABLE IF EXISTS nope', loose);
    ok(r, 'skipped nope');
    assert.equal(file(r), LOOSE);
  });

  change('IF EXISTS and IF NOT EXISTS take table names in any case', async () => {
    ok(await query('drop table if exists T', loose), 'dropped t');
    ok(await query('create table if not exists T (a integer)', loose), 'skipped t');
  });

  test('without IF EXISTS, DROP TABLE of a missing table is still exit 4', async () => fails(await query('DROP TABLE nope', loose), 4));
});

describe('the files sift writes', { concurrency: true }, () => {
  test('no temporary file is left after a write', async () => {
    const r = await query("INSERT INTO t VALUES (3, 'c')", loose);
    ok(r, 'inserted 1');
    noTemp(r);
    assert.deepEqual(dbFiles(r.dir), ['t.csv']);
  });

  test('files that are not tables are never touched', async () => {
    const files = { 'db/Upper.csv': 'x\n', 'db/notes.txt': 'keep\n', 'db/.hidden.csv': 'h\n' };
    const r = await query('DELETE FROM t', { tables: { t: LOOSE }, files });
    ok(r, 'deleted 2');
    assert.deepEqual(dbFiles(r.dir), ['.hidden.csv', 'Upper.csv', 'notes.txt', 't.csv']);
    for (const [name, body] of Object.entries(files)) assert.equal(read(r.dir, name), body);
  });

  test('a table a statement does not change is never touched', async () => {
    const r = await query('INSERT INTO c SELECT * FROM t', { tables: { t: LOOSE, c: lines('id:integer,name:text') } });
    ok(r, 'inserted 2');
    assert.equal(file(r), LOOSE);
    assert.equal(file(r, 'c'), lines('id:integer,name:text', '1,a', '2,b'));
  });

  test('a failed statement leaves no temporary file and no new table', async () => {
    const r = await query("INSERT INTO t VALUES (CAST('x' AS INTEGER), 'c')", loose);
    fails(r, 6);
    assert.deepEqual(dbFiles(r.dir), ['t.csv']);
  });
});
