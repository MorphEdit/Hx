// Fake `gh` for tests: the board lives in the JSON file named by HX_FAKE_STATE.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const file = process.env.HX_FAKE_STATE;
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = (s) => { writeFileSync(file + '.tmp', JSON.stringify(s, null, 2)); renameSync(file + '.tmp', file); };
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const all = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const find = (s, n) => s.issues.find((i) => i.number === Number(n));

const s = load();
if (a[0] === 'issue' && a[1] === 'list') {
  const out = s.issues.filter((i) => i.state === 'OPEN').map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) }));
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
  const i = find(s, a[2]);
  i.labels = [...new Set([...i.labels, ...all('--add-label')])].filter((l) => !all('--remove-label').includes(l));
  save(s);
} else if (a[0] === 'issue' && a[1] === 'comment') {
  let body = '';
  process.stdin.on('data', (d) => (body += d)).on('end', () => {
    const cur = load();
    cur.comments.push({ issue: Number(a[2]), body });
    save(cur);
  });
} else if (a[0] === 'issue' && a[1] === 'close') {
  find(s, a[2]).state = 'CLOSED';
  save(s);
} else {
  process.stderr.write(`fake gh: unsupported ${a.join(' ')}`);
  process.exit(1);
}
void opt;
