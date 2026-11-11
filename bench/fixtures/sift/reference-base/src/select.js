// SELECT: the result's columns (items, `*`, aliases, names, types), WHERE, ORDER BY (positions, aliases, NULLs),
// DISTINCT and LIMIT/OFFSET, in the brief's order of work. Joins, grouping and subqueries plug in from their modules.
import { checkError } from './errors.js';
import { Scope, compile, hasAggregate } from './expr.js';
import { planGrouped } from './grouping.js';
import { planJoins } from './joins.js';
import { compareSame } from './values.js';

/**
 * The result items of `sel`, `*` and `<t>.*` spread into one item per column: `{ name, node, alias }`, `node` an
 * expression (a column reference for the columns of a star).
 */
function expandItems(sel, scope) {
  const out = [];
  const starColumn = (src, c) => ({ k: 'col', table: src.known, name: c.name, key: c.name, star: true });
  for (const item of sel.items) {
    if (item.kind === 'star') {
      if (scope.sources.length === 0) throw checkError('* needs a FROM');
      for (const src of scope.sources) for (const c of src.columns) out.push({ name: c.name, node: starColumn(src, c), alias: null });
    } else if (item.kind === 'tstar') {
      const src = scope.sources.find((s) => s.known === item.table);
      if (!src) throw checkError(`no such table: ${item.table}`);
      for (const c of src.columns) out.push({ name: c.name, node: starColumn(src, c), alias: null });
    } else {
      const name = item.alias ?? (item.expr.k === 'col' ? item.expr.name : `col${out.length + 1}`);
      out.push({ name, node: item.expr, alias: item.alias });
    }
  }
  return out;
}

/**
 * Each ORDER BY item as `{ item, desc, nulls }` (a result column, by position or alias, or with DISTINCT the same
 * expression as an item) or `{ node, desc, nulls }` (an expression to work out per row).
 */
function resolveOrder(sel, items) {
  return sel.orderBy.map(({ expr, desc, nulls }) => {
    const base = { desc, nulls };
    if (expr.k === 'lit' && expr.type === 'integer') {
      if (expr.value < 1n || expr.value > BigInt(items.length)) throw checkError(`ORDER BY ${expr.value} is not a result column`);
      return { ...base, item: Number(expr.value) - 1 };
    }
    if (expr.k === 'col' && expr.table === null) {
      const named = items.flatMap((it, k) => (it.alias === expr.name ? [k] : []));
      if (named.length > 1) throw checkError(`ORDER BY ${expr.name} is ambiguous`);
      if (named.length === 1) return { ...base, item: named[0] };
    }
    if (sel.distinct) {
      const k = items.findIndex((it) => it.node.key === expr.key);
      if (k < 0) throw checkError('with DISTINCT, ORDER BY takes result columns only');
      return { ...base, item: k };
    }
    return { ...base, node: expr };
  });
}

/** Is `sel` a grouped query: GROUP BY, HAVING, or an aggregate in its items or ORDER BY. */
export function isGrouped(sel) {
  return sel.groupBy.length > 0 || sel.having !== null
    || sel.items.some((it) => it.kind === 'expr' && hasAggregate(it.expr)) || sel.orderBy.some((o) => hasAggregate(o.expr));
}

/** A condition (WHERE, HAVING, ON) compiled in `cx`: a boolean, or exit 5. */
export function condition(node, cx, what) {
  const c = compile(node, cx);
  if (c.type !== null && c.type !== 'boolean') throw checkError(`${what} takes a boolean, not ${c.type}`);
  return c;
}

/**
 * Check `sel` against the session's tables and plan it: `{ columns, types, run(rt) }`, `run` giving the result rows
 * as arrays of values (values.js). Every check error is met here, before anything runs.
 */
export function planSelect(sel, env) {
  const scope = new Scope();
  if (sel.from) scope.add(sel.from.alias ?? sel.from.name, env.session.table(sel.from.name));
  const joined = sel.joins.length > 0 ? planJoins(sel, scope, env) : null;
  const where = sel.where ? condition(sel.where, { scope, env, aggregateWhere: 'in WHERE' }, 'WHERE') : null;
  const items = expandItems(sel, scope);
  const order = resolveOrder(sel, items);
  let types;
  let perRow;
  let grouped = null;
  if (isGrouped(sel)) {
    grouped = planGrouped(sel, scope, items, order, env);
    types = grouped.items.map((c) => c.type);
  } else {
    const cx = { scope, env, aggregateWhere: 'in a query that is not grouped' };
    const cs = items.map((it) => compile(it.node, cx));
    const keys = order.map((o) => (o.item !== undefined ? { item: o.item } : { c: compile(o.node, cx) }));
    types = cs.map((c) => c.type);
    perRow = (row, rt) => {
      const vals = cs.map((c) => c.ev(row, rt));
      return { vals, keys: keys.map((k) => (k.item !== undefined ? vals[k.item] : k.c.ev(row, rt))) };
    };
  }
  const run = (rt) => {
    const source = joined ? joined.rows(rt) : sel.from ? scope.sources[0].table.rows : [[]];
    const kept = where ? source.filter((row) => where.ev(row, rt) === true) : source;
    let out = grouped ? grouped.run(kept, rt) : kept.map((row) => perRow(row, rt));
    if (sel.distinct) out = distinct(out);
    if (order.length > 0) out = sortRows(out, order);
    if (sel.limit !== null) {
      const from = sel.offset === null ? 0 : Number(sel.offset);
      out = out.slice(from, from + Number(sel.limit));
    }
    return out.map((r) => r.vals);
  };
  return { columns: items.map((it) => it.name), types, run };
}

/** A row's values as one text: equal rows (all NULLs equal) give equal keys. */
export function rowKey(vals) {
  return vals.map((v) => (v === null ? 'n' : `${typeof v}:${String(v).length}:${String(v)}`)).join('|');
}

/** The first of every set of equal rows, where it was. */
export function distinct(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = rowKey(r.vals);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * `rows` sorted stably by their `keys`, item by item: ascending unless `desc`; NULL before every value (so first
 * ascending, last descending) unless `nulls` puts it first or last.
 */
export function sortRows(rows, order) {
  return [...rows].sort((a, b) => {
    for (let k = 0; k < order.length; k++) {
      const { desc, nulls } = order[k];
      const x = a.keys[k];
      const y = b.keys[k];
      if (x === null && y === null) continue;
      if (x === null || y === null) {
        const nullFirst = nulls === 'first' || (nulls === null && !desc);
        return (x === null) === nullFirst ? -1 : 1;
      }
      const c = compareSame(x, y);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}
