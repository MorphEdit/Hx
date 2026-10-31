// Fake `gh` for tests: the board lives in the JSON file named by HX_FAKE_STATE.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadJson, locked, saveJson } from './lock.mjs';

const file = process.env.HX_FAKE_STATE;
const load = () => loadJson(file);
const save = (s) => saveJson(file, s);
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const all = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const find = (s, n) => s.issues.find((i) => i.number === Number(n));
const withStdin = (fn) => { let body = ''; process.stdin.on('data', (d) => (body += d)).on('end', () => fn(body)); };
const mutate = (fn) => locked(file, () => { const cur = load(); const r = fn(cur); save(cur); return r; });
const ghLabels = (i) => i.labels.map((name) => ({ name }));

const s = load();
// HX_FAKE_GH_LOG: every call appends its arguments as one line (tests count calls)
if (process.env.HX_FAKE_GH_LOG) appendFileSync(process.env.HX_FAKE_GH_LOG, a.join(' ') + '\n');
// the account gh is logged in as: state.login (default 'me'); state.loginFails makes `gh api user` fail.
// An issue or comment without an `author` was opened by it; author '' = a deleted account (gh gives no login).
const LOGIN = s.login ?? 'me';
const author = (x) => ({ login: x.author ?? LOGIN });
if (a[0] === 'issue' && a[1] === 'list') {
  if (s.listFails) { process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1); }
  const state = opt('--state') ?? 'open';
  const out = s.issues.filter((i) => state === 'all' || i.state === state.toUpperCase()).map((i) => ({ ...i, labels: ghLabels(i), author: author(i) }));
  // state.slowList = { add, wake, ms }: a slow read — once the list is taken, `add` joins the board and `wake` is
  // written, then the answer (without it) comes ms later (a wake that lands while hx reads the board)
  const slow = s.slowList && mutate((cur) => { const x = cur.slowList; delete cur.slowList; if (x) cur.issues.push(x.add); return x; });
  if (slow) { writeFileSync(slow.wake, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow.ms); }
  process.stdout.write(JSON.stringify(out));
} else if (a[0] === 'pr' && a[1] === 'list') {
  // like gh, --head matches the branch name only: a PR from a fork (`fork: true`) with that name matches too
  // state.prListLag = k: a new PR is missing from the next k lists (GitHub's delay, see #65)
  const hidden = mutate((cur) => (cur.prs ?? []).filter((p) => p.head === opt('--head') && p.state === 'OPEN' && p.hide > 0)
    .map((p) => { p.hide--; return p.number; }));
  const prs = (s.prs ?? []).filter((p) => p.head === opt('--head') && p.state === 'OPEN' && !hidden.includes(p.number));
  if (opt('-q')) process.stdout.write(prs[0] ? `${prs[0].number}\n` : '\n');
  else process.stdout.write(JSON.stringify(prs.map((p) => ({ number: p.number, isCrossRepository: !!p.fork }))));
} else if (a[0] === 'pr' && a[1] === 'create') {
  const number = mutate((cur) => {
    cur.prs ??= [];
    const n = 100 + cur.prs.length;
    cur.prs.push({ number: n, head: opt('--head'), base: opt('--base'), title: opt('--title'), state: 'OPEN', hide: cur.prListLag ?? 0 });
    return n;
  });
  process.stdout.write(`https://github.com/me/app/pull/${number}\n`);
} else if (a[0] === 'pr' && a[1] === 'view') {
  const pr = [...(s.prs ?? [])].reverse().find((p) => p.head === a[2] && !p.fork);
  if (!pr) { process.stderr.write(`no pull requests found for branch "${a[2]}"`); process.exit(1); }
  process.stdout.write(JSON.stringify({ number: pr.number, state: pr.state }));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  // HX_FAKE_AUTOMERGE: the repo only accepts auto-merge, which lands (and closes the issue) at once
  if (process.env.HX_FAKE_AUTOMERGE && !a.includes('--auto')) { process.stderr.write('Pull request is not mergeable'); process.exit(1); }
  mutate((cur) => {
    const pr = (cur.prs ?? []).find((p) => p.number === Number(a[2]));
    pr.state = 'MERGED';
    pr.mergedHead = opt('--match-head-commit');
    if (process.env.HX_FAKE_AUTOMERGE) { const n = Number(/issue\/(\d+)/.exec(pr.head)?.[1]); const i = find(cur, n); if (i) i.state = 'CLOSED'; }
  });
} else if (a[0] === 'issue' && a[1] === 'view' && opt('-q') === '.state') {
  process.stdout.write(find(s, a[2]).state + '\n');
} else if (a[0] === 'issue' && a[1] === 'view') {
  const i = find(s, a[2]);
  if (!i) { process.stderr.write(`GraphQL: Could not resolve to an issue or pull request with the number of ${a[2]}.`); process.exit(1); }
  const fields = opt('--json').split(',');
  const out = {};
  // authors are stored as a login string, or left out (a deleted account: gh gives no login)
  const ghAuthor = (login) => (login ? { login } : null);
  for (const k of ['number', 'title', 'state', 'createdAt']) if (fields.includes(k)) out[k] = i[k];
  if (fields.includes('author')) out.author = ghAuthor(i.author);
  if (fields.includes('labels')) out.labels = ghLabels(i);
  if (fields.includes('body')) out.body = i.body;
  if (fields.includes('comments')) {
    out.comments = s.comments.filter((c) => c.issue === i.number)
      .map((c) => ({ author: ghAuthor(c.author ?? LOGIN), body: c.body, createdAt: c.createdAt ?? '' }));
  }
  process.stdout.write(JSON.stringify(out));
} else if (a[0] === 'api' && a[1] === 'user') {
  if (s.loginFails) { process.stderr.write('HTTP 401: Bad credentials'); process.exit(1); }
  process.stdout.write(opt('-q') === '.login' ? `${LOGIN}
` : JSON.stringify({ login: LOGIN }));
} else if (a[0] === 'api') {
  const path = a.find((x) => x.startsWith('repos/'));
  const one = /issues\/(\d+)$/.exec(path);
  if (one) {
    const i = find(s, one[1]);
    if (!i) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
    process.stdout.write(i.state.toLowerCase() + '\n');
  } else {
    process.stdout.write(s.issues.map((i) => `${i.number}\t${i.state.toLowerCase()}\n`).join(''));
  }
} else if (a[0] === 'issue' && a[1] === 'edit') {
  // state.labelFails = k: the next k edits that remove a label fail (-1: every one)
  if (all('--remove-label').length && mutate((cur) => { if (!cur.labelFails) return false; if (cur.labelFails > 0) cur.labelFails--; return true; })) {
    process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1);
  }
  const edit = (body) => mutate((cur) => {
    const i = find(cur, a[2]);
    i.labels = [...new Set([...i.labels, ...all('--add-label')])].filter((l) => !all('--remove-label').includes(l));
    if (body !== undefined) i.body = body;
  });
  const bf = opt('--body-file');
  if (bf === '-') withStdin(edit);
  else edit(bf === undefined ? undefined : readFileSync(bf, 'utf8'));
} else if (a[0] === 'label' && a[1] === 'create') {
  mutate((cur) => { cur.labels = [...new Set([...(cur.labels ?? []), a[2]])]; });
} else if (a[0] === 'repo' && a[1] === 'view') {
  process.stdout.write(opt('-q') === '.defaultBranchRef.name' ? 'main\n' : 'me/app\n');
} else if (a[0] === 'issue' && a[1] === 'comment') {
  withStdin((body) => mutate((cur) => { cur.comments.push({ issue: Number(a[2]), body, author: LOGIN }); }));
} else if (a[0] === 'issue' && a[1] === 'close') {
  mutate((cur) => {
    find(cur, a[2]).state = 'CLOSED';
    if (opt('--comment')) cur.comments.push({ issue: Number(a[2]), body: opt('--comment'), author: LOGIN });
  });
} else if (a[0] === 'issue' && a[1] === 'create') {
  withStdin((body) => {
    const number = mutate((cur) => {
      const n = Math.max(0, ...cur.issues.map((i) => i.number)) + 1;
      cur.issues.push({ number: n, title: opt('--title'), body, state: 'OPEN', labels: all('--label'), author: LOGIN });
      return n;
    });
    process.stdout.write(`https://github.com/me/app/issues/${number}\n`);
  });
} else {
  process.stderr.write(`fake gh: unsupported ${a.join(' ')}`);
  process.exit(1);
}
