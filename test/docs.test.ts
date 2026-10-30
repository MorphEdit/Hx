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
