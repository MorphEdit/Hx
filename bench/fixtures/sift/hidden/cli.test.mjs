// The command line: usage, exit codes, which error wins, stdout and stderr, SIFT_DB and SIFT_TODAY, tables and schema.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CUSTOMERS, FRUIT, change, csv, dbFiles, fails, fileErrorAt, lines, ok, query, read, sift, workdir } from './helpers.mjs';

describe('the command line', { concurrency: true }, () => {
  test('no command is a usage error', async () => {
    fails(await sift([]), 1);
  });

  test('an unknown command is a usage error', async () => {
    fails(await sift(['frobnicate']), 1);
  });

  test('query without its statement is a usage error', async () => {
    fails(await sift(['query']), 1);
  });

  test('query with an extra argument is a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', 'SELECT 2']), 1);
  });

  test('run without its script is a usage error', async () => {
    fails(await sift(['run']), 1);
  });

  test('schema without its table is a usage error', async () => {
    fails(await sift(['schema']), 1);
  });

  test('schema with an extra argument is a usage error', async () => {
    fails(await sift(['schema', 'fruit', 'more'], { tables: { fruit: FRUIT } }), 1);
  });

  test('tables with an argument is a usage error', async () => {
    fails(await sift(['tables', 'fruit']), 1);
  });

  test('an unknown option is a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', '--color']), 1);
  });

  test('tables takes no option', async () => {
    fails(await sift(['tables', '--format', 'csv']), 1);
  });

  test('schema takes no option', async () => {
    fails(await sift(['schema', 'fruit', '--format', 'csv'], { tables: { fruit: FRUIT } }), 1);
  });

  test('--format given twice is a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', '--format', 'csv', '--format', 'csv']), 1);
  });

  test('--format without its value is a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', '--format']), 1);
  });

  test('a --format value that is not a format is a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', '--format', 'xml']), 1);
    fails(await sift(['query', 'SELECT 1', '--format', 'CSV']), 1);
  });

  test('--format=csv is not an option but an extra argument', async () => {
    fails(await sift(['query', 'SELECT 1', '--format=csv']), 1);
  });

  test('schema of a name that is not an identifier is a usage error', async () => {
    for (const name of ['1abc', 'my-table', 'select', 'a b']) fails(await sift(['schema', name]), 1);
  });

  test('a usage error wins over a missing SIFT_DB and a bad SIFT_TODAY', async () => {
    fails(await sift(['nope'], { db: null, today: '2023-02-29' }), 1);
    fails(await sift(['query'], { db: null }), 1);
  });

  test('a SIFT_DB that is not set is exit 2', async () => {
    fails(await query('SELECT 1', { db: null }), 2);
    fails(await sift(['tables'], { db: null }), 2);
  });

  test('an empty SIFT_DB is exit 2', async () => {
    fails(await query('SELECT 1', { db: '' }), 2);
  });

  test('a SIFT_DB naming no directory is exit 2, and sift does not create it', async () => {
    const r = await query('CREATE TABLE t (a INTEGER)', { db: 'nowhere' });
    fails(r, 2);
    assert.equal(existsSync(path.join(r.dir, 'nowhere')), false);
  });

  test('a SIFT_DB naming a file is exit 2', async () => {
    fails(await query('SELECT 1', { db: 'note.txt', files: { 'note.txt': 'hi\n' } }), 2);
  });

  test('SIFT_DB is relative to the current folder', async () => {
    const dir = workdir({ files: { 'data/inner/t.csv': lines('a:integer', '7') } });
    ok(await csv('SELECT a FROM t', { dir, db: 'data/inner' }), 'a', '7');
  });

  test('a SIFT_TODAY that is not a real date is exit 2, even when nothing uses today', async () => {
    for (const today of ['2023-02-29', '2024-3-15', 'tomorrow', '2024-13-01']) fails(await query('SELECT 1', { today }), 2);
    fails(await sift(['tables'], { today: '2023-02-29' }), 2);
  });

  test('SIFT_TODAY is checked before SIFT_DB, so both wrong is still exit 2', async () => {
    fails(await query('SELECT 1', { today: 'nope', db: null }), 2);
  });

  test('run of a script that does not exist is exit 2', async () => {
    fails(await sift(['run', 'missing.sql']), 2);
  });

  test('run of a folder is exit 2: it cannot be read as a script', async () => {
    const dir = workdir();
    mkdirSync(path.join(dir, 'scripts'));
    fails(await sift(['run', 'scripts'], { dir }), 2);
  });

  test('the environment wins over a syntax error', async () => {
    fails(await query('SELECT FROM WHERE', { db: null }), 2);
    fails(await sift(['run', 'missing.sql'], { db: 'nowhere' }), 2);
  });

  test('a syntax error wins over a missing table', async () => {
    fails(await query('SELECT * FROM missing WHERE'), 3);
  });

  test('a missing table wins over an unknown column', async () => {
    fails(await query('SELECT nope FROM missing'), 4);
  });

  test('a broken table file wins over an unknown column', async () => {
    fileErrorAt(await query('SELECT nope FROM t', { tables: { t: lines('a:integer', 'x') } }), 't.csv', 2);
  });

  test('tables are checked in the order their names first appear: a broken first table is reported', async () => {
    const tables = { broken: lines('a:integer', '1', 'zz'), fine: lines('a:integer', '1') };
    fileErrorAt(await query('SELECT * FROM broken JOIN missing ON TRUE', { tables }), 'broken.csv', 3);
  });

  test('a missing table named before a broken one is the one reported', async () => {
    const r = await query('SELECT * FROM missing JOIN broken ON TRUE', { tables: { broken: lines('a:integer', 'zz') } });
    fails(r, 4);
    assert.equal(r.stderr.includes('broken.csv'), false, r.stderr);
  });

  test('a check error wins over a run-time error', async () => {
    fails(await query("SELECT CAST('x' AS INTEGER), nope"), 5);
  });

  test('a run-time error is exit 6', async () => {
    fails(await query("SELECT CAST('x' AS INTEGER)"), 6);
  });

  test('success is exit 0 with the results on stdout', async () => {
    const r = await csv('SELECT 1');
    ok(r, 'col1', '1');
  });

  test('an error is one line on stderr starting with "error: " and nothing on stdout', async () => {
    const r = await query('SELECT nope');
    fails(r, 5);
    assert.match(r.stderr, /^error: /);
  });

  test('a table file must match its name exactly: Fruit.csv is not the table fruit', async () => {
    fails(await query('SELECT * FROM fruit', { files: { 'db/Fruit.csv': FRUIT } }), 4);
  });

  test('a broken table file that no statement names is never an error', async () => {
    ok(await csv('SELECT 1', { tables: { broken: '"oops\n' } }), 'col1', '1');
  });

  test('tables prints the table names sorted, one per line', async () => {
    const dir = workdir({
      tables: { b: lines('a:integer'), a_1: lines('a:integer'), a: lines('a:integer'), x9: lines('a:integer') },
      files: { 'db/Upper.csv': 'a:integer\n', 'db/1x.csv': 'a:integer\n', 'db/select.csv': 'a:integer\n', 'db/.hidden.csv': 'a:integer\n',
        'db/notes.txt': 'hi\n', 'db/t.CSV': 'a:integer\n', 'db/sub/inner.csv': 'a:integer\n', 'db/my-table.csv': 'a:integer\n' },
    });
    mkdirSync(path.join(dir, 'db', 'folder.csv'));
    ok(await sift(['tables'], { dir }), 'a', 'a_1', 'b', 'x9');
  });

  test('tables does not read the files', async () => {
    ok(await sift(['tables'], { tables: { broken: '"never closed\n', empty: '' } }), 'broken', 'empty');
  });

  test('tables sorts the names by their character codes: digits, then _, then letters', async () => {
    ok(await sift(['tables'], { tables: { ab: lines('a:integer'), a_b: lines('a:integer'), a1: lines('a:integer'), aa: lines('a:integer') } }), 'a1', 'a_b', 'aa', 'ab');
  });

  test('tables with no tables prints nothing', async () => {
    ok(await sift(['tables'], { files: { 'db/notes.txt': 'x' } }));
  });

  test('schema prints each column and its type in small letters', async () => {
    ok(await sift(['schema', 't'], { tables: { t: lines('ID:INTEGER,Name:Text,when_:date,ok:Boolean,p:DECIMAL', '1,a,2024-01-01,true,1.5') } }),
      'id integer', 'name text', 'when_ date', 'ok boolean', 'p decimal');
  });

  test('schema takes the table name in any case', async () => {
    ok(await sift(['schema', 'FRUIT'], { tables: { fruit: FRUIT } }), 'id integer', 'name text', 'price decimal', 'in_stock boolean', 'added date');
  });

  test('schema of a table that does not exist is exit 4', async () => {
    fails(await sift(['schema', 'nope']), 4);
  });

  test('schema reads the file: a broken one is exit 4 with its line', async () => {
    fileErrorAt(await sift(['schema', 't'], { tables: { t: lines('a:integer', '1', '2', 'x') } }), 't.csv', 4);
  });

  test('options may come before the arguments', async () => {
    ok(await sift(['query', '--format', 'csv', 'SELECT 2']), 'col1', '2');
  });

  test('a statement starting with "-- comment" is an argument, not an option', async () => {
    ok(await sift(['query', '-- first\nSELECT 3', '--format', 'csv']), 'col1', '3');
  });

  test('run takes --format', async () => {
    ok(await sift(['run', 'q.sql', '--format', 'json'], { files: { 'q.sql': 'SELECT 1 AS a' } }), '{"columns":["a"],"rows":[[1]]}');
  });

  test('an error creates, changes and deletes no file', async () => {
    const r = await query("INSERT INTO customers VALUES (5, 'Eve', 'Oslo'), (6, 'Fay', 'x' || CAST('y' AS INTEGER))", { tables: { customers: CUSTOMERS } });
    fails(r, 6);
    assert.equal(read(r.dir, 'db/customers.csv'), CUSTOMERS);
    assert.deepEqual(dbFiles(r.dir), ['customers.csv']);
  });

  change('--format markdown is a format of query and run', async () => {
    ok(await sift(['query', 'SELECT 1 AS a', '--format', 'markdown']), '| a |', '| ---: |', '| 1 |');
    ok(await sift(['run', 'q.sql', '--format', 'markdown'], { files: { 'q.sql': "SELECT 'x' AS b" } }), '| b |', '| --- |', '| x |');
  });

  test('--format markdown given twice is still a usage error', async () => {
    fails(await sift(['query', 'SELECT 1', '--format', 'markdown', '--format', 'markdown']), 1);
    fails(await sift(['query', 'SELECT 1', '--format', 'md']), 1);
  });

  test('tables still takes no option, markdown included', async () => {
    fails(await sift(['tables', '--format', 'markdown']), 1);
  });
});
