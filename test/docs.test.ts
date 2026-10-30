// The docs and the CLI help describe the PRD flow with the config keys, defaults and labels hx ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const LIFECYCLE = 'gauntlet → decompose → building → review → security → done';

test('README: lifecycle, round comments, original body, config keys with their defaults, labels', () => {
  const r = read('README.md');
  assert.ok(r.includes(LIFECYCLE));
  for (const m of ['<!-- hx-gauntlet -->', '<!-- hx-security -->', '<!-- hx-prd-original -->']) assert.ok(r.includes(m), m);
  for (const k of ['gauntlet', 'security'] as const) assert.match(r, new RegExp(`\| \`${k}\` \| \`${DEFAULTS[k]}\` \|`), k);
  for (const k of ['gauntletRounds', 'securityRounds'] as const) assert.match(r, new RegExp(`\| \`${k}\` \| ${DEFAULTS[k]} \|`), k);
  const labels = r.split('\n').find((l) => l.startsWith('| `labels`'))!;
  for (const l of [DEFAULTS.labels.hardened, DEFAULTS.labels.secured, DEFAULTS.labels.security]) assert.ok(labels.includes(`\`${l}\``), l);
});

test('author filter: README security section + trustedAuthors row, design #9 done, CLAUDE.md, help', () => {
  const r = read('README.md');
  assert.match(r, /\| `trustedAuthors` \| `\[\]` \|/);
  for (const w of ['scripts/issue.mjs', 'gh api user', '`untrusted`', 'trusted account']) assert.ok(r.includes(w), w);
  assert.match(read('docs/design.md'), /\| 9 \| ~~\*\*Author filter\*\*~~ done \|[^\n]*#26/);
  const c = read('CLAUDE.md');
  assert.ok(c.split('\n').some((l) => l.startsWith('- `scripts/issue.mjs`')), 'issue.mjs under Where things are');
  assert.match(c, /only through `scripts\/issue\.mjs` \(never `gh issue view --comments`\)/);
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  for (const w of ['untrusted', 'trustedAuthors']) assert.ok(h.stdout.includes(w), w);
});

test('design.md marks roadmap #3 (gauntlet) done', () => {
  assert.match(read('docs/design.md'), /\| 3 \| ~~\*\*Gauntlet[^|]*~~ done \|/);
});

test('CLAUDE.md lists every prompt and names #5 (rtdd) next', () => {
  const c = read('CLAUDE.md');
  const line = c.split('\n').find((l) => l.startsWith('- `prompts/`'))!;
  for (const f of readdirSync(path.join(root, 'prompts'))) assert.ok(line.includes(`\`${f.replace(/\.md$/, '')}\``), f);
  assert.match(c.slice(c.indexOf('## Next up')), /Next is #5 \(rtdd\)/);
});

test('hx help: the PRD-flow paragraph mentions the gauntlet and the security pass', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const w of ['gauntlet -> decompose -> building -> review -> security -> done', 'gauntletRounds', 'securityRounds',
    DEFAULTS.labels.hardened, DEFAULTS.labels.secured, 'security pass']) assert.ok(r.stdout.includes(w), w);
});

test('dashboard: README section, design #8 done, CLAUDE.md file map', () => {
  const r = read('README.md');
  const sec = r.slice(r.indexOf('## Dashboard'), r.indexOf('\n## ', r.indexOf('## Dashboard') + 1));
  assert.ok(sec.length > 100, 'README has a Dashboard section');
  for (const w of ['hx dashboard', '--port', '--open', '**Now**', '**Board**', '**Stats**', '**Log**', '.hx/run.log', 'run.log.1',
    '127.0.0.1 only', 'Host', 'GET only', 'read', 'escaped text']) assert.ok(sec.includes(w), w);
  assert.doesNotMatch(sec, /\.(png|jpe?g|gif)\b/i, 'no screenshots');
  assert.match(read('docs/design.md'), /\| 8 \| ~~\*\*Web dashboard \/ stats\*\*~~ done \|/);
  const c = read('CLAUDE.md');
  const map = c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions'));
  for (const f of ['dashboard.ts', 'dashboard.html', 'outcomes.ts']) assert.ok(map.includes(`\`${f}\``), f);
});
