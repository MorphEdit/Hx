// The parser: the whole language of the brief, every statement and expression form, as a tree. Execution is not its
// business: it only says what was written, and where.
//
// Every expression node has `k` (its kind), `line` and `column` (where it starts) and `key`: its tokens once case and
// spacing are ignored, which is how "the same expression" is told (GROUP BY, DISTINCT with ORDER BY).
// Every table a statement names is in its `tables`: `{ name, at }`, `at` the token's index, in the order of the text.
import { syntaxError } from './errors.js';
import { tokenize } from './lexer.js';
import { TYPES } from './values.js';

const COMPARISONS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

export const isAggregateName = (name) => AGGREGATES.has(name);

class Parser {
  constructor(text) {
    this.toks = tokenize(text);
    this.i = 0;
    this.tables = [];
  }

  get tok() { return this.toks[this.i]; }
  peek(n = 1) { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }

  fail(tok = this.tok, what) {
    if (tok.kind === 'error') throw syntaxError(tok.line, tok.column, tok.value);
    const found = tok.kind === 'eof' ? 'the end of the input' : JSON.stringify(tok.kind === 'str' ? `'${tok.value}'` : String(tok.value));
    throw syntaxError(tok.line, tok.column, what ? `expected ${what} but found ${found}` : `unexpected ${found}`);
  }

  isKw(word, tok = this.tok) { return tok.kind === 'kw' && tok.value === word; }
  isSym(s, tok = this.tok) { return tok.kind === 'sym' && tok.value === s; }
  isId(word, tok = this.tok) { return tok.kind === 'id' && tok.value === word; }

  acceptKw(word) {
    if (!this.isKw(word)) return false;
    this.i++;
    return true;
  }

  acceptSym(s) {
    if (!this.isSym(s)) return false;
    this.i++;
    return true;
  }

  kw(word) {
    if (!this.acceptKw(word)) this.fail(this.tok, word.toUpperCase());
  }

  sym(s) {
    if (!this.acceptSym(s)) this.fail(this.tok, `"${s}"`);
  }

  ident(what = 'a name') {
    const t = this.tok;
    if (t.kind !== 'id') this.fail(t, what);
    this.i++;
    return t.value;
  }

  /** A table name, recorded in the statement's tables. */
  tableName() {
    const at = this.i;
    const name = this.ident('a table name');
    this.tables.push({ name, at });
    return { name, at };
  }

  typeName() {
    const t = this.tok;
    if (t.kind !== 'id' || !TYPES.includes(t.value)) this.fail(t, 'a type (INTEGER, DECIMAL, TEXT, BOOLEAN or DATE)');
    this.i++;
    return t.value;
  }

  /** An optional `[AS] <alias>`. */
  alias() {
    if (this.acceptKw('as')) return this.ident('an alias');
    if (this.tok.kind === 'id') return this.ident();
    return null;
  }

  /** A node of kind `k` starting at token `t0`, its key and position filled in once the parser is past it. */
  node(t0, props) {
    const first = this.toks[t0];
    const n = { ...props, line: first.line, column: first.column, t0, t1: this.i };
    n.key = this.toks.slice(t0, this.i).map(tokenKey).join(' ');
    return n;
  }

  // --- statements ------------------------------------------------------------------------------------------------------

  statement() {
    const start = this.tables.length;
    let s;
    if (this.isKw('select')) s = this.select();
    else if (this.isKw('insert')) s = this.insert();
    else if (this.isKw('update')) s = this.update();
    else if (this.isKw('delete')) s = this.del();
    else if (this.isKw('create')) s = this.create();
    else if (this.isKw('drop')) s = this.drop();
    else this.fail(this.tok, 'a statement');
    s.tables = this.tables.slice(start);
    return s;
  }

  /**
   * A query: one SELECT, or SELECTs joined by `UNION [ALL]`, as `{ type: 'select', union: { parts, all }, orderBy,
   * limit, offset }`, the ORDER BY and LIMIT written after the last SELECT applying to the whole union. A SELECT of a
   * union other than the last cannot have ORDER BY or LIMIT: a syntax error at that ORDER or LIMIT.
   */
  select() {
    const t0 = this.i;
    const first = this.selectOne();
    if (!this.isKw('union')) return first;
    const parts = [first];
    const all = [];
    while (this.isKw('union')) {
      const prev = parts[parts.length - 1];
      if (prev.orderTok || prev.limitTok) this.fail(prev.orderTok ?? prev.limitTok);
      this.i++;
      all.push(this.acceptKw('all'));
      parts.push(this.selectOne());
    }
    const last = parts[parts.length - 1];
    const { orderBy, limit, offset } = last;
    Object.assign(last, { orderBy: [], limit: null, offset: null });
    return { type: 'select', union: { parts, all }, orderBy, limit, offset, line: this.toks[t0].line, column: this.toks[t0].column };
  }

  /** One SELECT, its ORDER BY and LIMIT included. */
  selectOne() {
    const t0 = this.i;
    this.kw('select');
    const distinct = this.acceptKw('distinct');
    const items = [this.selectItem()];
    while (this.acceptSym(',')) items.push(this.selectItem());
    let from = null;
    const joins = [];
    if (this.acceptKw('from')) {
      const t = this.tableName();
      from = { name: t.name, at: t.at, alias: this.alias() };
      for (;;) {
        let kind;
        if (this.isKw('join')) kind = 'inner';
        else if (this.isKw('inner')) { this.i++; kind = 'inner'; if (!this.isKw('join')) this.fail(this.tok, 'JOIN'); }
        else if (this.isKw('left')) { this.i++; kind = 'left'; this.acceptKw('outer'); if (!this.isKw('join')) this.fail(this.tok, 'JOIN'); }
        else break;
        this.kw('join');
        const jt = this.tableName();
        const alias = this.alias();
        this.kw('on');
        joins.push({ kind, name: jt.name, at: jt.at, alias, on: this.expr() });
      }
    }
    const where = this.acceptKw('where') ? this.expr() : null;
    const groupBy = [];
    if (this.acceptKw('group')) {
      this.kw('by');
      groupBy.push(this.expr());
      while (this.acceptSym(',')) groupBy.push(this.expr());
    }
    const having = this.acceptKw('having') ? this.expr() : null;
    const orderBy = [];
    const orderTok = this.isKw('order') ? this.tok : null;
    if (this.acceptKw('order')) {
      this.kw('by');
      do orderBy.push(this.orderItem()); while (this.acceptSym(','));
    }
    let limit = null;
    let offset = null;
    const limitTok = this.isKw('limit') ? this.tok : null;
    if (this.acceptKw('limit')) {
      limit = this.intLiteral();
      if (this.acceptKw('offset')) offset = this.intLiteral();
    }
    return { type: 'select', distinct, items, from, joins, where, groupBy, having, orderBy, limit, offset, orderTok, limitTok,
      line: this.toks[t0].line, column: this.toks[t0].column };
  }

  intLiteral() {
    const t = this.tok;
    if (t.kind !== 'int') this.fail(t, 'an integer');
    this.i++;
    return t.value;
  }

  selectItem() {
    const t0 = this.i;
    if (this.acceptSym('*')) return { kind: 'star', line: this.toks[t0].line, column: this.toks[t0].column };
    if (this.tok.kind === 'id' && this.isSym('.', this.peek()) && this.isSym('*', this.peek(2))) {
      const table = this.tok.value;
      this.i += 3;
      return { kind: 'tstar', table, line: this.toks[t0].line, column: this.toks[t0].column };
    }
    const expr = this.expr();
    return { kind: 'expr', expr, alias: this.alias() };
  }

  orderItem() {
    const expr = this.expr();
    let desc = false;
    if (this.acceptKw('desc')) desc = true;
    else this.acceptKw('asc');
    let nulls = null;
    if (this.acceptKw('nulls')) {
      if (this.isId('first')) nulls = 'first';
      else if (this.isId('last')) nulls = 'last';
      else this.fail(this.tok, 'FIRST or LAST');
      this.i++;
    }
    return { expr, desc, nulls };
  }

  insert() {
    const t0 = this.i;
    this.kw('insert');
    this.kw('into');
    const t = this.tableName();
    let columns = null;
    if (this.isSym('(')) {
      this.i++;
      columns = [this.columnRef()];
      while (this.acceptSym(',')) columns.push(this.columnRef());
      this.sym(')');
    }
    let values = null;
    let select = null;
    if (this.acceptKw('values')) {
      values = [this.valuesRow()];
      while (this.acceptSym(',')) values.push(this.valuesRow());
    } else if (this.isKw('select')) select = this.select();
    else this.fail(this.tok, 'VALUES or SELECT');
    return { type: 'insert', table: t.name, at: t.at, columns, values, select, ...this.pos(t0) };
  }

  /** A column name with its position, for statements that name columns of their table. */
  columnRef() {
    const t = this.tok;
    return { name: this.ident('a column name'), line: t.line, column: t.column };
  }

  valuesRow() {
    this.sym('(');
    const row = [this.expr()];
    while (this.acceptSym(',')) row.push(this.expr());
    this.sym(')');
    return row;
  }

  update() {
    const t0 = this.i;
    this.kw('update');
    const t = this.tableName();
    this.kw('set');
    const sets = [];
    do {
      const column = this.columnRef();
      this.sym('=');
      sets.push({ column, expr: this.expr() });
    } while (this.acceptSym(','));
    const where = this.acceptKw('where') ? this.expr() : null;
    return { type: 'update', table: t.name, at: t.at, sets, where, ...this.pos(t0) };
  }

  del() {
    const t0 = this.i;
    this.kw('delete');
    this.kw('from');
    const t = this.tableName();
    const where = this.acceptKw('where') ? this.expr() : null;
    return { type: 'delete', table: t.name, at: t.at, where, ...this.pos(t0) };
  }

  create() {
    const t0 = this.i;
    this.kw('create');
    this.kw('table');
    let ifNotExists = false;
    if (this.acceptKw('if')) {
      this.kw('not');
      this.kw('exists');
      ifNotExists = true;
    }
    const t = this.tableName();
    this.sym('(');
    const columns = [];
    do {
      const c = this.columnRef();
      columns.push({ ...c, type: this.typeName() });
    } while (this.acceptSym(','));
    this.sym(')');
    return { type: 'create', table: t.name, at: t.at, columns, ifNotExists, ...this.pos(t0) };
  }

  drop() {
    const t0 = this.i;
    this.kw('drop');
    this.kw('table');
    let ifExists = false;
    if (this.acceptKw('if')) {
      this.kw('exists');
      ifExists = true;
    }
    const t = this.tableName();
    return { type: 'drop', table: t.name, at: t.at, ifExists, ...this.pos(t0) };
  }

  pos(t0) { return { line: this.toks[t0].line, column: this.toks[t0].column }; }

  // --- expressions -----------------------------------------------------------------------------------------------------

  expr() { return this.or(); }

  or() {
    const t0 = this.i;
    let l = this.and();
    while (this.acceptKw('or')) l = this.node(t0, { k: 'or', l, r: this.and() });
    return l;
  }

  and() {
    const t0 = this.i;
    let l = this.not();
    while (this.acceptKw('and')) l = this.node(t0, { k: 'and', l, r: this.not() });
    return l;
  }

  not() {
    const t0 = this.i;
    if (this.acceptKw('not')) return this.node(t0, { k: 'not', e: this.not() });
    return this.comparison();
  }

  comparison() {
    const t0 = this.i;
    const l = this.additive();
    const t = this.tok;
    if (t.kind === 'sym' && COMPARISONS.has(t.value)) {
      this.i++;
      const op = t.value === '!=' ? '<>' : t.value;
      return this.node(t0, { k: 'cmp', op, l, r: this.additive() });
    }
    if (this.acceptKw('is')) {
      const not = this.acceptKw('not');
      this.kw('null');
      return this.node(t0, { k: 'isnull', not, e: l });
    }
    let not = false;
    if (this.isKw('not') && (this.isKw('in', this.peek()) || this.isKw('like', this.peek()) || this.isKw('between', this.peek()))) {
      this.i++;
      not = true;
    }
    if (this.acceptKw('in')) {
      this.sym('(');
      if (this.isKw('select')) {
        const select = this.select();
        this.sym(')');
        return this.node(t0, { k: 'insub', not, e: l, select });
      }
      const list = [this.expr()];
      while (this.acceptSym(',')) list.push(this.expr());
      this.sym(')');
      return this.node(t0, { k: 'in', not, e: l, list });
    }
    if (this.acceptKw('like')) return this.node(t0, { k: 'like', not, l, r: this.additive() });
    if (this.acceptKw('between')) {
      const lo = this.additive();
      this.kw('and');
      return this.node(t0, { k: 'between', not, e: l, lo, hi: this.additive() });
    }
    return l;
  }

  additive() {
    const t0 = this.i;
    let l = this.multiplicative();
    while (this.isSym('+') || this.isSym('-') || this.isSym('||')) {
      const op = this.tok.value;
      this.i++;
      l = this.node(t0, { k: 'bin', op, l, r: this.multiplicative() });
    }
    return l;
  }

  multiplicative() {
    const t0 = this.i;
    let l = this.unary();
    while (this.isSym('*') || this.isSym('/') || this.isSym('%')) {
      const op = this.tok.value;
      this.i++;
      l = this.node(t0, { k: 'bin', op, l, r: this.unary() });
    }
    return l;
  }

  unary() {
    const t0 = this.i;
    if (this.acceptSym('-')) return this.node(t0, { k: 'neg', e: this.unary() });
    return this.primary();
  }

  primary() {
    const t0 = this.i;
    const t = this.tok;
    switch (t.kind) {
      case 'int': this.i++; return this.node(t0, { k: 'lit', type: 'integer', value: t.value });
      case 'dec': this.i++; return this.node(t0, { k: 'lit', type: 'decimal', text: t.value });
      case 'str': this.i++; return this.node(t0, { k: 'lit', type: 'text', value: t.value });
      case 'kw':
        if (t.value === 'true' || t.value === 'false') { this.i++; return this.node(t0, { k: 'lit', type: 'boolean', value: t.value === 'true' }); }
        if (t.value === 'null') { this.i++; return this.node(t0, { k: 'lit', type: null, value: null }); }
        if (t.value === 'cast') return this.cast();
        if (t.value === 'case') return this.caseExpr();
        break;
      case 'sym':
        if (t.value === '(') {
          this.i++;
          if (this.isKw('select')) {
            const select = this.select();
            this.sym(')');
            return this.node(t0, { k: 'sub', select });
          }
          const e = this.expr();
          this.sym(')');
          return this.node(t0, { k: 'paren', e });
        }
        break;
      case 'id': {
        if (this.isSym('(', this.peek())) return this.call();
        this.i++;
        if (this.acceptSym('.')) {
          const name = this.ident('a column name');
          return this.node(t0, { k: 'col', table: t.value, name });
        }
        return this.node(t0, { k: 'col', table: null, name: t.value });
      }
      default:
    }
    return this.fail(t, 'an expression');
  }

  call() {
    const t0 = this.i;
    const name = this.tok.value;
    this.i += 2;
    if (name === 'count' && this.isSym('*')) {
      this.i++;
      this.sym(')');
      return this.node(t0, { k: 'call', name, args: [], star: true });
    }
    const args = [];
    if (!this.isSym(')')) {
      args.push(this.expr());
      while (this.acceptSym(',')) args.push(this.expr());
    }
    this.sym(')');
    return this.node(t0, { k: 'call', name, args, star: false });
  }

  cast() {
    const t0 = this.i;
    this.kw('cast');
    this.sym('(');
    const e = this.expr();
    this.kw('as');
    const type = this.typeName();
    this.sym(')');
    return this.node(t0, { k: 'cast', e, type });
  }

  caseExpr() {
    const t0 = this.i;
    this.kw('case');
    const base = this.isKw('when') ? null : this.expr();
    const whens = [];
    do {
      this.kw('when');
      const when = this.expr();
      this.kw('then');
      whens.push({ when, then: this.expr() });
    } while (this.isKw('when'));
    const otherwise = this.acceptKw('else') ? this.expr() : null;
    this.kw('end');
    return this.node(t0, { k: 'case', base, whens, else: otherwise });
  }
}

/** A token as it counts for "the same expression": keywords and names in small letters, literals by their value. */
function tokenKey(t) {
  if (t.kind === 'str') return `'${t.value.replace(/'/g, "''")}'`;
  return String(t.value);
}

/** One statement, as `sift query` takes it: an optional `;`, then nothing. */
export function parseStatement(text) {
  const p = new Parser(text);
  const s = p.statement();
  p.acceptSym(';');
  if (p.tok.kind !== 'eof') p.fail(p.tok);
  return s;
}

/** A script: statements separated by `;`, the last `;` optional; no statement at all is a script too. */
export function parseScript(text) {
  const p = new Parser(text);
  const out = [];
  while (p.tok.kind !== 'eof') {
    out.push(p.statement());
    if (p.tok.kind === 'eof') break;
    p.sym(';');
  }
  return out;
}
