// The statements that change tables (INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE) and writing the changed tables
// when a run has succeeded. A statement changes only the session (`Session.set`, `Session.drop`); `commit` writes
// every table the run changed, each atomically, once the whole run has succeeded.
import { lstatSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkError, tableError } from './errors.js';
import { csvField } from './csv.js';
import { Scope, castFn, compile } from './expr.js';
import { condition, planSelect } from './select.js';
import { intToDec, print } from './values.js';

/** Run a statement that changes tables, in `env` (`{ session, today, before }`): `{ message }`. */
export function executeWrite(stmt, env) {
  switch (stmt.type) {
    case 'insert': return insert(stmt, env);
    case 'update': return update(stmt, env);
    case 'delete': return del(stmt, env);
    case 'create': return create(stmt, env);
    case 'drop': return drop(stmt, env);
    default: throw new Error(`unknown statement ${stmt.type}`);
  }
}

/** The steps that run before the statement (its subqueries, in text order), then the run's `rt`. */
function start(env) {
  const rt = { today: env.today, session: env.session };
  for (const step of env.before) step(rt);
  return rt;
}

/**
 * How a value of type `from` is stored in a column of type `to`: its own type, an integer into a decimal, a text into
 * a date as a cast does, NULL into anything. Any other pair is exit 5.
 */
export function assigner(from, to, column) {
  if (from === null || from === to) return (v) => v;
  if (from === 'integer' && to === 'decimal') return (v) => (v === null ? null : intToDec(v));
  if (from === 'text' && to === 'date') {
    const f = castFn('text', 'date');
    return (v) => (v === null ? null : f(v));
  }
  throw checkError(`column ${column} takes ${to}, not ${from}`);
}

/** A column of `table` by name: its index, or exit 5. */
function columnIndex(table, name) {
  const k = table.columns.findIndex((c) => c.name === name);
  if (k < 0) throw checkError(`no such column: ${table.name}.${name}`);
  return k;
}

function insert(stmt, env) {
  const table = env.session.table(stmt.table);
  let targets = table.columns.map((_, k) => k);
  if (stmt.columns) {
    targets = stmt.columns.map((c) => columnIndex(table, c.name));
    const dup = stmt.columns.find((c, k) => targets.indexOf(targets[k]) !== k);
    if (dup) throw checkError(`column ${dup.name} is named twice`);
  }
  const width = table.columns.length;
  const build = (vals) => {
    const row = new Array(width).fill(null);
    targets.forEach((k, j) => { row[k] = vals[j]; });
    return row;
  };
  let produce;
  if (stmt.values) {
    // values name no column: an empty scope makes every column name "no such column"
    const cx = { scope: new Scope(), env, aggregateWhere: 'in INSERT … VALUES' };
    const rows = stmt.values.map((vals) => {
      if (vals.length !== targets.length) throw checkError(`${vals.length} values where there are ${targets.length} columns to fill`);
      return vals.map((node, j) => {
        const c = compile(node, cx);
        const col = table.columns[targets[j]];
        const put = assigner(c.type, col.type, col.name);
        return (rt) => put(c.ev([], rt));
      });
    });
    produce = (rt) => rows.map((vals) => build(vals.map((v) => v(rt))));
  } else {
    const plan = planSelect(stmt.select, env);
    if (plan.columns.length !== targets.length) {
      throw checkError(`the SELECT gives ${plan.columns.length} columns where there are ${targets.length} to fill`);
    }
    const puts = targets.map((k, j) => assigner(plan.types[j], table.columns[k].type, table.columns[k].name));
    produce = (rt) => plan.run(rt).map((vals) => build(vals.map((v, j) => puts[j](v))));
  }
  const added = produce(start(env));
  if (added.length > 0) env.session.set(table.name, { ...table, rows: [...table.rows, ...added] });
  return { message: `inserted ${added.length}` };
}

/** The scope of UPDATE and DELETE: their one table, known by its name. */
function tableScope(table) {
  const scope = new Scope();
  scope.add(table.name, table);
  return scope;
}

function update(stmt, env) {
  const table = env.session.table(stmt.table);
  const scope = tableScope(table);
  const cx = { scope, env, aggregateWhere: 'in UPDATE' };
  const seen = new Set();
  const sets = stmt.sets.map(({ column, expr }) => {
    const k = columnIndex(table, column.name);
    if (seen.has(k)) throw checkError(`column ${column.name} is set twice`);
    seen.add(k);
    const c = compile(expr, cx);
    return { k, c, put: assigner(c.type, table.columns[k].type, column.name) };
  });
  const where = stmt.where ? condition(stmt.where, cx, 'WHERE') : null;
  const rt = start(env);
  let n = 0;
  const rows = table.rows.map((row) => {
    if (where && where.ev(row, rt) !== true) return row;
    n++;
    const next = [...row];
    for (const { k, c, put } of sets) next[k] = put(c.ev(row, rt));
    return next;
  });
  if (n > 0) env.session.set(table.name, { ...table, rows });
  return { message: `updated ${n}` };
}

function del(stmt, env) {
  const table = env.session.table(stmt.table);
  const where = stmt.where ? condition(stmt.where, { scope: tableScope(table), env, aggregateWhere: 'in DELETE' }, 'WHERE') : null;
  const rt = start(env);
  const rows = where ? table.rows.filter((row) => where.ev(row, rt) !== true) : [];
  const n = table.rows.length - rows.length;
  if (n > 0) env.session.set(table.name, { ...table, rows });
  return { message: `deleted ${n}` };
}

function create(stmt, env) {
  const columns = [];
  for (const c of stmt.columns) {
    if (columns.some((x) => x.name === c.name)) throw checkError(`two columns named ${c.name}`);
    columns.push({ name: c.name, type: c.type });
  }
  env.session.set(stmt.table, { name: stmt.table, columns, rows: [] });
  return { message: `created ${stmt.table}` };
}

function drop(stmt, env) {
  env.session.drop(stmt.table);
  return { message: `dropped ${stmt.table}` };
}

// --- writing ---------------------------------------------------------------------------------------------------------

/** A table as sift writes its file: the header, then one line per row, every line ending with `\n`. */
export function tableText({ columns, rows }) {
  const field = (type, v) => {
    if (v === null) return '';
    const s = print(type, v);
    return s === '' ? '""' : csvField(s);
  };
  const out = [columns.map((c) => `${c.name}:${c.type}`).join(',')];
  for (const row of rows) out.push(row.map((v, k) => field(columns[k].type, v)).join(','));
  return out.map((l) => `${l}\n`).join('');
}

let tempCount = 0;

/**
 * Write every table the session changed, each once with its final rows, and delete the ones it dropped. Every new
 * file is first written to a `.sift-` temporary file in the data directory; only when all of them are written are they
 * renamed over the tables' files. No temporary file is left, whatever happens. A table created and dropped by the run
 * has nothing to write.
 */
export function commit(session) {
  const writes = [];
  const drops = [];
  for (const [name, table] of session.overlay) {
    if (table) writes.push({ name, file: path.join(session.dir, `${name}.csv`), text: tableText(table) });
    else if (session.files.has(name)) drops.push(path.join(session.dir, `${name}.csv`));
  }
  if (writes.length === 0 && drops.length === 0) return;
  const temps = [];
  try {
    for (const w of writes) {
      // a file of this name that is not a file (a folder) is not a table, and sift never replaces it
      let st = null;
      try { st = lstatSync(w.file); } catch { st = null; }
      if (st && !st.isFile()) throw tableError(`cannot write ${w.name}.csv: something that is not a table file is in its place`);
      w.temp = path.join(session.dir, `.sift-${process.pid}-${Date.now()}-${tempCount++}.tmp`);
      temps.push(w.temp);
      try { writeFileSync(w.temp, w.text, { flag: 'wx' }); } catch (e) {
        throw tableError(`cannot write ${w.name}.csv: ${e.code ?? e.message}`);
      }
    }
    for (const w of writes) {
      try { renameSync(w.temp, w.file); } catch (e) { throw tableError(`cannot write ${w.name}.csv: ${e.code ?? e.message}`); }
    }
    for (const file of drops) {
      try { unlinkSync(file); } catch (e) {
        if (e.code !== 'ENOENT') throw tableError(`cannot delete ${path.basename(file)}: ${e.code ?? e.message}`);
      }
    }
  } finally {
    for (const t of temps) rmSync(t, { force: true });
  }
}
