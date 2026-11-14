// Grouping and aggregates: GROUP BY, HAVING and COUNT, SUM, AVG, MIN, MAX. A grouped query's items, HAVING and
// ORDER BY are compiled at the level of a group: what they work out from is `{ keys, aggs }`, the group's GROUP BY
// values and its aggregates' values, so a column outside both is exit 5 before anything runs.
import { checkError } from './errors.js';
import { compile } from './expr.js';
import { rowKey } from './select.js';
import { SCALE, checkDec, checkInt, compareSame, divRound, isNumber } from './values.js';

/** One aggregate: its result type from its argument's, and `fold(values)` over the argument's values for a group. */
function aggregateOf(name, argType) {
  const needNumber = () => {
    if (argType !== null && !isNumber(argType)) throw checkError(`${name.toUpperCase()} takes a number, not ${argType}`);
  };
  const present = (vs) => vs.filter((v) => v !== null);
  switch (name) {
    case 'count': return { type: 'integer', fold: (vs) => BigInt(present(vs).length) };
    case 'sum':
      needNumber();
      return { type: argType, fold: (vs) => {
        const xs = present(vs);
        if (xs.length === 0) return null;
        const total = xs.reduce((a, b) => a + b, 0n);
        return argType === 'decimal' ? checkDec(total) : checkInt(total);
      } };
    case 'avg':
      needNumber();
      return { type: 'decimal', fold: (vs) => {
        const xs = present(vs);
        if (xs.length === 0) return null;
        const total = xs.reduce((a, b) => a + b, 0n) * (argType === 'integer' ? SCALE : 1n);
        return checkDec(divRound(total, BigInt(xs.length)));
      } };
    case 'min': case 'max': {
      const better = name === 'min' ? (c) => c < 0 : (c) => c > 0;
      return { type: argType, fold: (vs) => present(vs).reduce((best, v) => (best === null || better(compareSame(v, best)) ? v : best), null) };
    }
    default: throw new Error(`not an aggregate: ${name}`);
  }
}

/**
 * A grouped query (select.js decides that it is one): its result items and ORDER BY keys worked out per group.
 * Returns `{ items: [{ type }], run(rows, rt) }`, `run` taking the rows WHERE kept and giving `[{ vals, keys }]`, one
 * per group in group order.
 */
export function planGrouped(sel, scope, items, order, env) {
  const rowCx = { scope, env, aggregateWhere: 'in GROUP BY' };
  const groupBy = sel.groupBy.map((node) => ({ node, c: compile(node, rowCx) }));
  // a `*` column is grouped when a GROUP BY item is a reference to that same column
  const groupedIndex = (node) => groupBy.findIndex((g) => g.node.k === 'col' && node.k === 'col'
    && scope.resolve(g.node.table, g.node.name).index === scope.resolve(node.table, node.name).index);
  const aggs = [];
  const argCx = { scope, env, aggregateWhere: 'inside another aggregate' };
  const groupCx = {
    scope,
    env,
    hook(node) {
      let k = groupBy.findIndex((g) => g.node.key === node.key);
      if (k < 0 && node.k === 'col' && node.star) k = groupedIndex(node);
      if (k >= 0) return { type: groupBy[k].c.type, ev: (g) => g.keys[k] };
      if (node.k === 'col') throw checkError(`${node.table ? `${node.table}.` : ''}${node.name} must be in GROUP BY or inside an aggregate`);
      return null;
    },
    aggregate(node) {
      const name = node.name;
      if (node.star) {
        aggs.push({ arg: null, fold: (vs) => BigInt(vs.length) });
      } else {
        if (node.args.length !== 1) throw checkError(`${name.toUpperCase()} takes one argument, not ${node.args.length}`);
        const arg = compile(node.args[0], argCx);
        aggs.push({ arg, ...aggregateOf(name, arg.type) });
      }
      const slot = aggs.length - 1;
      return { type: node.star ? 'integer' : aggs[slot].type, ev: (g) => g.aggs[slot] };
    },
  };
  const cs = items.map((it) => compile(it.node, groupCx));
  const having = sel.having ? compile(sel.having, groupCx) : null;
  if (having && having.type !== null && having.type !== 'boolean') throw checkError(`HAVING takes a boolean, not ${having.type}`);
  const keys = order.map((o) => (o.item !== undefined ? { item: o.item } : { c: compile(o.node, groupCx) }));
  const run = (rows, rt) => {
    // the GROUP BY items for each row, the groups in the order of their first row; no GROUP BY is one group of all
    const groups = new Map();
    for (const row of rows) {
      const vals = groupBy.map((g) => g.c.ev(row, rt));
      const k = rowKey(vals);
      if (!groups.has(k)) groups.set(k, { keys: vals, rows: [] });
      groups.get(k).rows.push(row);
    }
    if (groupBy.length === 0 && groups.size === 0) groups.set('', { keys: [], rows: [] });
    const all = [...groups.values()];
    for (const g of all) g.aggs = aggs.map((a) => a.fold(a.arg ? g.rows.map((row) => a.arg.ev(row, rt)) : g.rows));
    const kept = having ? all.filter((g) => having.ev(g, rt) === true) : all;
    return kept.map((g) => {
      const vals = cs.map((c) => c.ev(g, rt));
      return { vals, keys: keys.map((k) => (k.item !== undefined ? vals[k.item] : k.c.ev(g, rt))) };
    });
  };
  return { items: cs.map((c) => ({ type: c.type })), run };
}
