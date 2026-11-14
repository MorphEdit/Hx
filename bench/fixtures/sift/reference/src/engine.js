// One statement, run in a session: its tables checked (exit 4), the statement checked (exit 5), then run (exit 6).
import { tableError } from './errors.js';
import { planSelect } from './select.js';
import { toLibrary } from './values.js';
import { executeWrite } from './writes.js';

/**
 * The tables a statement names, in the order their names first appear in its text (its subqueries included), each
 * checked for existence and then read: exit 4. CREATE TABLE's own table must not exist (unless IF NOT EXISTS); DROP
 * TABLE's must exist (unless IF EXISTS) and is not read.
 */
export function checkTables(stmt, session) {
  const seen = new Set();
  for (const { name } of stmt.tables) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (stmt.type === 'create' && name === stmt.table) {
      if (session.exists(name) && !stmt.ifNotExists) throw tableError(`table ${name} already exists`);
    } else if (stmt.type === 'drop' && name === stmt.table) {
      if (!session.exists(name) && !stmt.ifExists) throw tableError(`no such table: ${name}`);
    } else {
      session.table(name);
    }
  }
}

/**
 * Run `stmt` in `env` (`{ session, today }`): a SELECT gives `{ columns, types, rows }` with the library's values,
 * any other statement `{ message }`.
 */
export function execute(stmt, env) {
  checkTables(stmt, env.session);
  const run = { ...env, before: [] };
  if (stmt.type !== 'select') return executeWrite(stmt, run);
  const plan = planSelect(stmt, run);
  const rt = { today: env.today, session: env.session };
  for (const step of run.before) step(rt);
  const rows = plan.run(rt);
  return { columns: plan.columns, types: plan.types, rows: rows.map((r) => r.map((v, k) => toLibrary(plan.types[k], v))) };
}
