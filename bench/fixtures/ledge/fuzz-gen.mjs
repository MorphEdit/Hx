// The blind case generator of the `ledge` fixture's differential fuzz (PRD #439): a seed and a count give the same
// cases on every machine. Written from bench/fixtures/ledge/brief.md only, never from the reference. Pure: it spawns
// nothing, reads no clock and imports only node: built-ins, so its source hash changes only when the cases can.
//
// A case is { id, feature, args, log, now }, as tally's: `args` the command line after `ledge`, `log` the journal (a
// Buffer, written as the manifest's ledger.journal and compared after the run, or null for no file), `now` the
// LEDGE_TODAY value. One data file per case: behaviours that need a second file (include, the budget file, CSV import)
// are graded by the hidden suite; here they appear only as their "file does not exist" errors. Each case reaches one
// feature (or none: `plain`) and keeps every other rule of the brief.
import { Buffer } from 'node:buffer';

export const FEATURES = [
  'spacing', 'comments', 'line-endings', 'elided', 'amounts', 'unbalanced', 'undeclared', 'bad-date', 'bad-field',
  'structure', 'filters', 'depth-sort', 'report', 'bad-today', 'usage', 'precedence', 'writes', 'csv-quoting',
  'missing-journal', 'missing-file',
];
export const DEFAULT_SEED = 1107;
export const DEFAULT_COUNT = 1000;

// Each block of 100 cases holds 20 plain ones and 4 of each feature, in a seeded order.
const BLOCK = [...Array(20).fill('plain'), ...FEATURES.flatMap((f) => Array(4).fill(f))];

/** The `count` cases of `seed`, in case order. Case i depends only on the seed and i. */
export function generate({ seed = DEFAULT_SEED, count = DEFAULT_COUNT } = {}) {
  const cases = [];
  let order = [];
  for (let id = 0; id < count; id++) {
    if (id % BLOCK.length === 0) order = random(seed, id / BLOCK.length, 1).shuffle(BLOCK.slice());
    const feature = order[id % BLOCK.length];
    cases.push({ id, feature, ...BUILD[feature](random(seed, id, 0)) });
  }
  return cases;
}

// --- the PRNG: mulberry32 over a seed mixed with the case (or block) number -------------------------------------

function random(seed, n, salt) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const x of [n, salt]) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    },
    some: (xs, lo, hi) => r.shuffle(xs.slice()).slice(0, r.int(lo, Math.min(hi, xs.length))),
  };
  return r;
}

// --- dates, amounts and names, written as the brief writes them ---------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const date = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** A real date between 2023-11-01 and 2024-06-30 (2024 is a leap year). */
function someDate(r) {
  const y = r.pick([2023, 2024, 2024, 2024]);
  const m = y === 2023 ? r.int(11, 12) : r.int(1, 6);
  return date(y, m, r.int(1, y === 2024 || m !== 2 ? DAYS[m - 1] : 28));
}
const someMonth = (r) => someDate(r).slice(0, 7);
/** Cents as the brief prints them. */
const money = (c) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${pad(Math.abs(c) % 100)}`;
const cents = (r) => r.pick([r.int(1, 999), r.int(100, 9999), r.int(1000, 250000), r.int(1, 20) * 500]);

const ACCOUNTS = [
  'Assets:Bank', 'Assets:Cash', 'Assets:Bank:Savings', 'Liabilities:Card', 'Equity:Opening', 'Income:Salary', 'Income:Gifts',
  'Expenses:Food', 'Expenses:Food:Coffee', 'Expenses:Rent', 'Expenses:Travel', 'Expenses:fun_2',
];
const UNDECLARED = ['Expenses:Gym', 'Assets:Wallet', 'Income:Bonus', 'Expenses:Food:Snacks'];
const CURRENCIES = ['USD', 'EUR', 'THB'];
const PAYEES = ['Corner Shop', 'ACME Ltd', 'Landlord', 'Cafe Bleu', 'corner shop', 'Train', 'Mum', 'Payroll #2', 'Shop; the best', 'x'];
const QUOTY = ['Shop, the corner', 'Joe "the" Deli', 'A,B,C', '"quoted"', 'say ""hi""', 'comma, and "quote"'];
const PREFIXES = ['Assets', 'Expenses', 'Expenses:Food', 'Income', 'Liabilities:Card', 'Equity', 'Assets:Bank'];

// --- the journal model: { accounts, txns }, each txn { date, payee, postings: [{ account, amount, currency, elide }] }

/** A valid journal: 3–9 declared accounts and 0–7 balanced transactions, some with one amount left out. */
function book(r, { min = 0, max = 7, elide = 0.3 } = {}) {
  const accounts = r.some(ACCOUNTS, 3, 9);
  const txns = [];
  const n = r.int(min, max);
  for (let i = 0; i < n; i++) txns.push(txn(r, accounts, elide));
  return { accounts, txns };
}

/** One balanced transaction over `accounts`: in one currency (or two, now and then), the last posting balancing it. */
function txn(r, accounts, elide = 0.3) {
  const currencies = r.chance(0.15) ? r.some(CURRENCIES, 2, 2) : [r.pick(CURRENCIES)];
  const postings = [];
  for (const currency of currencies) {
    const k = r.int(1, 3);
    let total = 0;
    for (let j = 0; j < k; j++) {
      const amount = r.chance(0.3) ? -cents(r) : cents(r);
      total += amount;
      postings.push({ account: r.pick(accounts), amount, currency, elide: false });
    }
    postings.push({ account: r.pick(accounts), amount: -total, currency, elide: false });
  }
  if (currencies.length === 1 && r.chance(elide)) postings[r.int(0, postings.length - 1)].elide = true;
  return { date: someDate(r), payee: r.pick(PAYEES), postings };
}

const SP = ['  ', '\t', ' \t', '   ', '\t\t', ' '];

/** The journal's lines; `style` changes how they are spaced (a feature's work). */
function render(st, style = {}) {
  const sep = style.sep ?? (() => ' ');
  const indent = style.indent ?? (() => '    ');
  const gap = style.gap ?? (() => '  ');
  const amount = style.amount ?? money;
  const lines = st.accounts.map((a) => `account${sep()}${a}`);
  for (const t of st.txns) {
    lines.push('');
    lines.push(`${t.date}${sep()}${t.payee}`);
    for (const p of t.postings) lines.push(p.elide ? `${indent()}${p.account}` : `${indent()}${p.account}${gap()}${amount(p.amount)}${sep()}${p.currency}`);
  }
  return lines;
}

const text = (lines, eol = '\n') => (lines.length ? lines.join(eol) + eol : '');
const done = (args, lines, now, eol) => ({ args, log: lines === null ? null : Buffer.from(text(lines, eol)), now });

// --- commands: one valid command line over a journal ------------------------------------------------------------

/** A few filters, each valid. */
function filters(r, st) {
  const out = [];
  if (r.chance(0.4)) for (const p of r.some([...PREFIXES, ...st.accounts], 1, 2)) out.push('--account', p);
  if (r.chance(0.3)) {
    const [a, b] = [someDate(r), someDate(r)].sort();
    if (r.chance(0.7)) out.push('--from', a);
    if (r.chance(0.7)) out.push('--to', b);
  }
  if (r.chance(0.25)) out.push('--payee', r.pick(['corner', 'ACME', 'shop', 'e', 'nobody', ';', '#2']));
  if (r.chance(0.2)) out.push('--currency', r.pick(CURRENCIES));
  return out;
}

const QUERIES = ['check', 'accounts', 'balance', 'register', 'report', 'print', 'export'];

/** A valid read-only command over `st`, maybe with filters. */
function query(r, st, kind = r.pick(QUERIES), withFilters = r.chance(0.5)) {
  const f = withFilters ? filters(r, st) : [];
  switch (kind) {
    case 'check':
    case 'accounts':
      return [kind];
    case 'report':
      return ['report', r.pick(['month', 'quarter', 'year']), ...f];
    default:
      return [kind, ...f];
  }
}

/** Options in a shuffled order (each option keeps its value right after it). */
function mix(r, head, opts) {
  const pairs = [];
  for (let i = 0; i < opts.length; i += 2) pairs.push([opts[i], opts[i + 1]]);
  return [...head, ...r.shuffle(pairs).flat()];
}

// --- the features: each breaks or stresses one rule and keeps the others ----------------------------------------------

/** A wrong journal line for the error features, by kind. */
const WRONG = {
  unbalanced: (r, st) => {
    const t = txn(r, st.accounts, 0);
    const p = t.postings[r.int(0, t.postings.length - 1)];
    p.amount += r.pick([1, -1, 100, -2500]);
    return t;
  },
};

const BUILD = {
  plain: (r) => {
    const st = book(r);
    return done(query(r, st), render(st), someDate(r));
  },
  spacing: (r) => {
    const st = book(r, { min: 1 });
    const trail = () => (r.chance(0.3) ? r.pick(SP) : '');
    const lines = render(st, { sep: () => r.pick(SP), indent: () => r.pick(['\t', ' ', '  ', '    ', ' \t']), gap: () => r.pick(SP) })
      .map((l) => (l === '' ? r.pick(['', ' ', '\t', '  \t']) : l + trail()));
    return done(query(r, st), lines, someDate(r));
  },
  comments: (r) => {
    const st = book(r, { min: 1 });
    const lines = render(st);
    for (let k = r.int(1, 5); k > 0; k--) {
      const c = `${r.pick(['', ' ', '\t', '    '])}${r.pick(['#', ';'])}${r.pick(['', ' note', ' 2024-01-01 not a date line', '    Assets:Bank 1.00 USD'])}`;
      lines.splice(r.int(0, lines.length), 0, c);
    }
    return done(query(r, st), lines, someDate(r));
  },
  'line-endings': (r) => {
    const st = book(r, { min: 1 });
    return done(query(r, st), render(st), someDate(r), r.chance(0.8) ? '\r\n' : '\n');
  },
  elided: (r) => {
    const st = book(r, { min: 1, elide: 1 });
    // now and then the elided posting first, or a second one (an error)
    const t = r.pick(st.txns);
    if (r.chance(0.3) && t.postings.length > 1) t.postings.forEach((p) => { p.elide = false; }), (t.postings[0].elide = true);
    if (r.chance(0.2)) t.postings.forEach((p, i) => { p.elide = i < 2; });
    return done(query(r, st, r.pick(['balance', 'register', 'print', 'check'])), render(st), someDate(r));
  },
  amounts: (r) => {
    const st = book(r, { min: 1, elide: 0 });
    const amount = (c) => (c === 0 && r.chance(0.5) ? '-0.00' : r.chance(0.4) ? `${c < 0 ? '-' : ''}${'0'.repeat(r.int(1, 3))}${money(Math.abs(c))}` : money(c));
    const t = r.pick(st.txns);
    if (r.chance(0.5)) t.postings.push({ account: t.postings[0].account, amount: 0, currency: t.postings[0].currency, elide: false });
    return done(query(r, st, r.pick(['balance', 'register', 'print', 'export'])), render(st, { amount }), someDate(r));
  },
  unbalanced: (r) => {
    const st = book(r);
    st.txns.splice(r.int(0, st.txns.length), 0, WRONG.unbalanced(r, st));
    return done(query(r, st), render(st), someDate(r));
  },
  undeclared: (r) => {
    const st = book(r, { min: 1 });
    const kind = r.int(0, 2);
    const lines = render(st);
    if (kind === 0) {
      // a posting to an account never declared
      const t = r.pick(st.txns);
      r.pick(t.postings).account = r.pick(UNDECLARED);
      return done(query(r, st), render(st), someDate(r));
    }
    if (kind === 1) {
      // an account declared a second time, somewhere after its first declaration
      lines.splice(r.int(st.accounts.length, lines.length), 0, '', `account ${r.pick(st.accounts)}`);
      return done(query(r, st), lines, someDate(r));
    }
    // a declaration moved below the transactions
    const moved = st.accounts.shift();
    const out = render(st);
    out.push('', `account ${moved}`);
    return done(query(r, st), out, someDate(r));
  },
  'bad-date': (r) => {
    const st = book(r, { min: 1 });
    r.pick(st.txns).date = r.pick(['2023-02-29', '2024-02-30', '2024-04-31', '2024-13-01', '2024-00-10', '2024-06-00', '2024-1-05', '24-01-05']);
    return done(query(r, st), render(st), someDate(r));
  },
  'bad-field': (r) => {
    const st = book(r, { min: 1, elide: 0 });
    const lines = render(st);
    const at = lines.findIndex((l) => /^ {4}\S+ {2}\S+ \S+$/.test(l));
    if (at >= 0) {
      const [account, amount, currency] = lines[at].trim().split(/\s+/);
      lines[at] = r.pick([
        `    ${account}  ${amount.slice(0, -1)} ${currency}`, `    ${account}  +${amount.replace('-', '')} ${currency}`,
        `    ${account}  ${amount} ${currency.toLowerCase()}`, `    ${account}  ${amount}`, `    ${account}  ${amount} ${currency} extra`,
        `    ${account.toLowerCase()}  ${amount} ${currency}`, `    ${account}  ${amount.replace('.', ',')} ${currency}`,
        `    ${account}:  ${amount} ${currency}`,
      ]);
    }
    if (r.chance(0.3)) lines.splice(r.int(0, st.accounts.length), 0, r.pick(['account Savings:Jar', 'account Assets:1st', 'account', 'account Assets:A Assets:B']));
    return done(query(r, st), lines, someDate(r));
  },
  structure: (r) => {
    const st = book(r);
    const lines = render(st);
    const breakIt = r.pick([
      () => lines.push('', `    ${r.pick(st.accounts)}  1.00 USD`),
      () => lines.push('', `${someDate(r)} ${r.pick(PAYEES)}`, `    ${r.pick(st.accounts)}  0.00 USD`),
      () => lines.push('', `${someDate(r)}${r.pick(['', ' ', '\t '])}`),
      () => lines.splice(r.int(0, lines.length), 0, r.pick(['commodity USD', 'Account Assets:Bank', 'includes x', '2024-01-0 x', 'x 2024-01-01'])),
      () => lines.push('', `${someDate(r)} Lone`, ''),
      () => lines.push('', `include ${r.pick(['nope.journal', 'other books.journal', 'sub/x.journal'])}`),
    ]);
    breakIt();
    return done(query(r, st), lines, someDate(r));
  },
  filters: (r) => {
    const st = book(r, { min: 2 });
    const kind = r.pick(['balance', 'register', 'print', 'export', 'report']);
    const head = kind === 'report' ? ['report', r.pick(['month', 'quarter', 'year'])] : [kind];
    const f = filters(r, st);
    if (!f.length) f.push('--account', r.pick(PREFIXES));
    return done(mix(r, head, f), render(st), someDate(r));
  },
  'depth-sort': (r) => {
    const st = book(r, { min: 1 });
    if (r.chance(0.6)) {
      const opts = [];
      if (r.chance(0.7)) opts.push('--depth', String(r.int(1, 4)));
      if (r.chance(0.7)) opts.push('--sort', r.pick(['name', 'amount']));
      if (r.chance(0.3)) opts.push(...filters(r, st));
      return done(mix(r, ['balance'], opts), render(st), someDate(r));
    }
    return done(mix(r, ['register'], ['--sort', r.pick(['date', 'amount']), ...filters(r, st)]), render(st), someDate(r));
  },
  report: (r) => {
    const st = book(r, { min: 2 });
    return done(['report', r.pick(['month', 'quarter', 'year']), ...(r.chance(0.3) ? filters(r, st) : [])], render(st), someDate(r));
  },
  'bad-today': (r) => {
    const st = book(r);
    const bad = r.pick(['2024-3-15', '2023-02-29', '2024-04-31', 'today', '15/03/2024', '2024-03-15T10:00', ' 2024-03-15', '2024-13-01']);
    return done(query(r, st), render(st), bad);
  },
  usage: (r) => {
    const st = book(r);
    const args = r.pick([
      () => [], () => [r.pick(['balances', 'help', 'Balance', 'report-month'])], () => ['balance', '--depth', r.pick(['0', '-1', 'x', '1.5', '+1'])],
      () => ['balance', '--sort', 'date'], () => ['register', '--sort', 'name'], () => ['register', '--depth', '1'], () => ['print', '--sort', 'amount'],
      () => ['balance', '--from', '2024-02-01', '--to', '2024-01-01'], () => ['balance', '--from', r.pick(['2024-02-30', '2024-2-01', 'yesterday'])],
      () => ['balance', '--account', r.pick(['assets', 'Assets:', 'Bank', 'Assets::Bank'])], () => ['balance', '--currency', r.pick(['usd', 'US', 'USDT'])],
      () => ['report'], () => ['report', 'week'], () => ['report', 'month', 'year'], () => ['check', 'extra'], () => ['balance', '--from'],
      () => ['balance', '--to', '2024-01-01', '--to', '2024-01-02'], () => ['check', '--account', 'Assets'], () => ['balance', '-v'], () => ['accounts', '-'],
      () => ['budget', r.pick(['2024-13', '2024-1', 'june'])], () => ['account'], () => ['account', 'Bank'], () => ['import', 'x.csv'],
      () => ['import', '--account', 'Assets:Bank'], () => ['add', someDate(r), 'x', 'Assets:Bank', '1.00', 'USD'],
      () => ['add', '2024-02-30', 'x', 'Assets:Bank', '1.00', 'USD', 'Equity:Opening'], () => ['add', someDate(r), ' ', 'Assets:Bank', 'Equity:Opening'],
      () => ['add', someDate(r), 'x', 'Assets:Bank', '1.0', 'USD', 'Equity:Opening'], () => ['add', someDate(r), 'x', 'Assets:Bank', '1.00', 'Equity:Opening'],
    ])();
    return done(args, render(st), someDate(r));
  },
  precedence: (r) => {
    // two things wrong at once, from different steps of the brief's list
    const st = book(r);
    const lines = render(st);
    const badJournal = r.chance(0.6);
    if (badJournal) lines.push('', r.pick(['oops', '    Assets:Bank  1.00 USD', 'account Assets:2']));
    const badToday = r.chance(0.5);
    const now = badToday ? r.pick(['2024-02-30', 'soon']) : someDate(r);
    const args = r.pick([
      () => ['balance', '--depth', '0'], () => query(r, st), () => ['budget', someMonth(r)], () => ['import', 'bank.csv', '--account', 'Assets:Bank'],
      () => ['add', someDate(r), 'x', 'Assets:Wallet', '1.00', 'USD', r.pick(st.accounts)], () => ['account', r.pick(st.accounts)],
    ])();
    return done(args, lines, now);
  },
  writes: (r) => {
    const st = book(r);
    const lines = render(st);
    // how the file ends: no final line break, or a blank last line
    const eol = r.pick(['\n', '\n', '\r\n']);
    let log = text(lines, eol);
    if (log && r.chance(0.2)) log = log.slice(0, -eol.length);
    if (log && r.chance(0.2)) log += r.pick(['\n', '  \n', '\t\n']);
    const declared = st.accounts;
    const args = r.pick([
      () => ['account', r.chance(0.7) ? r.pick(ACCOUNTS.concat(UNDECLARED)) : r.pick(declared)],
      () => {
        const a = r.pick(declared), b = r.pick(declared), c = cents(r);
        const cur = r.pick(CURRENCIES);
        const out = ['add', r.chance(0.2) ? 'today' : someDate(r), r.pick([...PAYEES, '  padded  ', 'tab\tinside']), a, money(c), cur];
        if (r.chance(0.5)) out.push(b); else out.push(b, money(-c + r.pick([0, 0, 0, 1])), cur);
        if (r.chance(0.2)) out.push(r.pick(declared), ...(r.chance(0.5) ? ['0.00', r.pick(CURRENCIES)] : []));
        if (r.chance(0.1)) out[3] = r.pick(UNDECLARED);
        return out;
      },
    ])();
    return { args, log: Buffer.from(log), now: someDate(r) };
  },
  'csv-quoting': (r) => {
    const st = book(r, { min: 1 });
    for (const t of st.txns) if (r.chance(0.6)) t.payee = r.pick(QUOTY);
    return done(['export', ...(r.chance(0.3) ? filters(r, st) : [])], render(st), someDate(r));
  },
  'missing-journal': (r) => {
    const st = { accounts: [], txns: [] };
    const args = r.chance(0.7) ? query(r, st) : r.pick([['account', r.pick(ACCOUNTS)], ['add', someDate(r), 'x', 'Assets:Bank', '1.00', 'USD', 'Equity:Opening']]);
    return done(args, null, someDate(r));
  },
  'missing-file': (r) => {
    const st = book(r);
    const args = r.pick([
      () => ['budget', ...(r.chance(0.5) ? [someMonth(r)] : [])], () => ['budget', '--budget', 'plans.budget'],
      () => ['import', 'bank.csv', '--account', r.pick(ACCOUNTS)], () => ['import', 'bank.csv', '--account', 'Assets:Bank', '--rules', 'r.txt'],
    ])();
    return done(args, r.chance(0.8) ? render(st) : null, someDate(r));
  },
};
