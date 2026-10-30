// Fake `gh` for tests: the board lives in the JSON file named by HX_FAKE_STATE.
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
if (a[0] === 'issue' && a[1] === 'list') {
  const state = opt('--state') ?? 'open';
  const out = s.issues.filter((i) => state === 'all' || i.state === state.toUpperCase()).map((i) => ({ ...i, labels: ghLabels(i) }));
  process.stdout.write(JSON.stringify(out));
} else if (a[0] === 'pr' && a[1] === 'list') {
  const pr = (s.prs ?? []).find((p) => p.head === opt('--head') && p.state === 'OPEN');
  process.stdout.write(pr ? `${pr.number}\n` : '\n');
} else if (a[0] === 'pr' && a[1] === 'create') {
  const number = mutate((cur) => {
    cur.prs ??= [];
    const n = 100 + cur.prs.length;
    cur.prs.push({ number: n, head: opt('--head'), base: opt('--base'), title: opt('--title'), state: 'OPEN' });
    return n;
  });
  process.stdout.write(`https://github.com/me/app/pull/${number}\n`);
} else if (a[0] === 'pr' && a[1] === 'merge') {
  // HX_FAKE_AUTOMERGE: the repo only accepts auto-merge, which lands (and closes the issue) at once
  if (process.env.HX_FAKE_AUTOMERGE && !a.includes('--auto')) { process.stderr.write('Pull request is not mergeable'); process.exit(1); }
  mutate((cur) => {
    const pr = (cur.prs ?? []).find((p) => p.number === Number(a[2]));
    pr.state = 'MERGED';
    if (process.env.HX_FAKE_AUTOMERGE) { const n = Number(/issue\/(\d+)/.exec(pr.head)?.[1]); const i = find(cur, n); if (i) i.state = 'CLOSED'; }
  });
} else if (a[0] === 'issue' && a[1] === 'view' && opt('-q') === '.state') {
  process.stdout.write(find(s, a[2]).state + '\n');
} else if (a[0] === 'issue' && a[1] === 'view') {
  const i = find(s, a[2]);
  const fields = opt('--json').split(',');
  const out = {};
  if (fields.includes('labels')) out.labels = ghLabels(i);
  if (fields.includes('comments')) out.comments = s.comments.filter((c) => c.issue === i.number).map((c) => ({ body: c.body }));
  process.stdout.write(JSON.stringify(out));
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
  mutate((cur) => {
    const i = find(cur, a[2]);
    i.labels = [...new Set([...i.labels, ...all('--add-label')])].filter((l) => !all('--remove-label').includes(l));
  });
} else if (a[0] === 'issue' && a[1] === 'comment') {
  withStdin((body) => mutate((cur) => { cur.comments.push({ issue: Number(a[2]), body }); }));
} else if (a[0] === 'issue' && a[1] === 'close') {
  mutate((cur) => {
    find(cur, a[2]).state = 'CLOSED';
    if (opt('--comment')) cur.comments.push({ issue: Number(a[2]), body: opt('--comment') });
  });
} else if (a[0] === 'issue' && a[1] === 'create') {
  withStdin((body) => {
    const number = mutate((cur) => {
      const n = Math.max(0, ...cur.issues.map((i) => i.number)) + 1;
      cur.issues.push({ number: n, title: opt('--title'), body, state: 'OPEN', labels: all('--label') });
      return n;
    });
    process.stdout.write(`https://github.com/me/app/issues/${number}\n`);
  });
} else {
  process.stderr.write(`fake gh: unsupported ${a.join(' ')}`);
  process.exit(1);
}
