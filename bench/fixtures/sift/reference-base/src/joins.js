// Joins: `[INNER] JOIN` and `LEFT [OUTER] JOIN`, made left to right. `planJoins` adds each joined table to the scope,
// checks its ON against the tables joined so far and the one being joined, and gives the joined rows.
import { checkError } from './errors.js';
import { compile } from './expr.js';

/**
 * The joins of `sel` over `scope` (which holds the FROM table already): `{ rows(rt) }`, every joined row as one array
 * of the scope's width, in the brief's row order.
 */
export function planJoins(sel, scope, env) {
  const steps = sel.joins.map((j) => {
    const src = scope.add(j.alias ?? j.name, env.session.table(j.name));
    // compiled now, so ON sees only the tables added so far
    const on = compile(j.on, { scope, env, aggregateWhere: 'in ON' });
    if (on.type !== null && on.type !== 'boolean') throw checkError(`ON takes a boolean, not ${on.type}`);
    return { left: j.kind === 'left', src, on };
  });
  return {
    rows(rt) {
      let rows = scope.sources[0].table.rows;
      for (const { left, src, on } of steps) {
        const right = src.table.rows;
        const nulls = src.columns.map(() => null);
        const out = [];
        for (const l of rows) {
          let matched = false;
          for (const r of right) {
            const row = [...l, ...r];
            if (on.ev(row, rt) === true) {
              out.push(row);
              matched = true;
            }
          }
          if (left && !matched) out.push([...l, ...nulls]);
        }
        rows = out;
      }
      return rows;
    },
  };
}
