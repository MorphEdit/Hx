// Fake `gh` for tests: the board lives in the JSON file named by HX_FAKE_STATE.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { locked } from './lock.mjs';

const file = process.env.HX_FAKE_STATE;
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = (s) => { writeFileSync(file + '.tmp', JSON.stringify(s, null, 2)); renameSync(file + '.tmp', file); };
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
