// The lexer: a statement's text as tokens, each with its line and column. A character sift cannot read ends the
// tokens with an `error` token at its place, so the parser reports it only when it gets there: the first syntax error
// in the text is the one reported.
import { INT_MAX } from './values.js';

export const RESERVED = new Set(['all', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'create', 'delete', 'desc',
  'distinct', 'drop', 'else', 'end', 'exists', 'false', 'from', 'group', 'having', 'if', 'in', 'inner', 'insert', 'into',
  'is', 'join', 'left', 'like', 'limit', 'not', 'null', 'nulls', 'offset', 'on', 'or', 'order', 'outer', 'select', 'set',
  'table', 'then', 'true', 'union', 'update', 'values', 'when', 'where']);

const SYMBOLS = ['<>', '!=', '<=', '>=', '||', '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', ',', '.', ';'];

const isDigit = (c) => c >= '0' && c <= '9';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isWordChar = (c) => isLetter(c) || isDigit(c) || c === '_';

/** An identifier as sift reads one: a letter or `_`, then letters, digits and `_`, and not a reserved word. */
export const isIdentifier = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !RESERVED.has(s.toLowerCase());

/**
 * The tokens of `text`: `{ kind, value, line, column }`, kind one of `kw` (a reserved word, value in small letters),
 * `id` (an identifier, in small letters), `int` (a bigint), `dec` (the literal's text), `str`, `sym`, then `eof` — or
 * `error` (value: what was wrong) at the first character that is not part of any token.
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (n) => {
    for (let k = 0; k < n; k++) {
      if (text[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  const push = (kind, value, l, c) => tokens.push({ kind, value, line: l, column: c });
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(1); continue; }
    const l = line;
    const cl = col;
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') advance(1);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { push('error', 'comment never closed', l, cl); return tokens; }
      advance(end + 2 - i);
      continue;
    }
    if (c === "'") {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= text.length) { push('error', 'text literal never closed', l, cl); return tokens; }
        if (text[j] === "'") {
          if (text[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += text[j++];
      }
      advance(j + 1 - i);
      push('str', s, l, cl);
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < text.length && isDigit(text[j])) j++;
      const whole = text.slice(i, j);
      if (text[j] === '.') {
        let k = j + 1;
        while (k < text.length && isDigit(text[k])) k++;
        const frac = text.slice(j + 1, k);
        if (frac.length === 0) { push('error', 'a decimal point needs a digit after it', l, cl); return tokens; }
        if (frac.length > 6) { push('error', 'more than 6 digits after the decimal point', l, cl); return tokens; }
        if (whole.length > 18) { push('error', 'more than 18 digits before the decimal point', l, cl); return tokens; }
        advance(k - i);
        push('dec', `${whole}.${frac}`, l, cl);
        continue;
      }
      const v = BigInt(whole);
      if (v > INT_MAX) { push('error', 'integer literal out of range', l, cl); return tokens; }
      advance(j - i);
      push('int', v, l, cl);
      continue;
    }
    if (isLetter(c) || c === '_') {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      const word = text.slice(i, j).toLowerCase();
      advance(j - i);
      push(RESERVED.has(word) ? 'kw' : 'id', word, l, cl);
      continue;
    }
    const sym = SYMBOLS.find((s) => text.startsWith(s, i));
    if (!sym) { push('error', `unexpected character ${JSON.stringify(c)}`, l, cl); return tokens; }
    advance(sym.length);
    push('sym', sym, l, cl);
  }
  push('eof', null, line, col);
  return tokens;
}
