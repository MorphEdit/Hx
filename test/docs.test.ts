// The docs and the CLI help describe the PRD flow with the config keys, defaults and labels hx ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.ts';
import { docsText } from './docs-text.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => (f === 'README.md' ? docsText() : readFileSync(path.join(root, f), 'utf8'));
const LIFECYCLE = 'gauntlet → decompose → building → review → security → bar → done';
// A config table row starting `| `key` | value |` (plain text, no regex).
const hasRow = (doc: string, key: string, value: string) => doc.split('\n').some((l) => l.startsWith(`| \`${key}\` | ${value} |`));

test('hasRow: only a row with that key and value matches', () => {
  const doc = '| key | default |\n|---|---|\n| `skillMaxChars` | `12000` | cap |\n| `rtddBin` | `"rtdd"` | cmd |';
  assert.ok(hasRow(doc, 'skillMaxChars', '`12000`'));
  assert.ok(hasRow(doc, 'rtddBin', '`"rtdd"`'));
  assert.ok(!hasRow(doc, 'skillMaxChars', '`99999`'));
  assert.ok(!hasRow(doc, 'rtddBin', '`"nope"`'));
  assert.ok(!hasRow('no table here', 'skillMaxChars', '`12000`'));
  assert.ok(!hasRow(read('README.md'), 'skillMaxChars', '`99999`'));
});

test('README: lifecycle, round comments, original body, config keys with their defaults, labels', () => {
  const r = read('README.md');
  assert.ok(r.includes(LIFECYCLE));
  for (const m of ['<!-- hx-gauntlet -->', '<!-- hx-security -->', '<!-- hx-prd-original -->']) assert.ok(r.includes(m), m);
  for (const k of ['gauntlet', 'security'] as const) assert.ok(hasRow(r, k, `\`${DEFAULTS[k]}\``), k);
  for (const k of ['gauntletRounds', 'securityRounds'] as const) assert.ok(hasRow(r, k, String(DEFAULTS[k])), k);
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

test('quality bar: README PRD flow, barRounds and barPassed rows, hx help, design.md, CLAUDE.md, decompose prompt', () => {
  const r = read('README.md');
  const start = r.indexOf('## PRD flow');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  for (const w of ['## Quality bar', 'Beat:', 'Judged on:', '.hx/bar/<prd>/ref/', 'r<N>/A', '.mapping', 'winner: A|B', 'gap: ',
    'no verdict', '<!-- hx-bar round=', 'trusted', 'reviewRounds', 'barRounds', '`quality-bar-passed`', 'standing gap'])
    assert.ok(sec.includes(w), w);
  assert.ok(hasRow(r, 'barRounds', String(DEFAULTS.barRounds)), 'barRounds row');
  const labels = r.split('\n').find((l) => l.startsWith('| `labels`'))!;
  assert.ok(labels.includes(`\`${DEFAULTS.labels.barPassed}\``) && labels.includes('`barPassed`'), 'barPassed label');
  assert.ok(r.split('\n').find((l) => l.startsWith('| `roleModels`'))!.includes('`bar`'), 'roleModels row names bar');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  for (const w of ['barRounds', DEFAULTS.labels.barPassed, 'quality bar']) assert.ok(h.stdout.includes(w), w);
  const d = read('docs/design.md');
  assert.match(d, /## Quality bar \(PRD #254\)/);
  assert.match(d, /\| Quality bar \(PRD #254\)[^\n]*\| done \|/);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('`bar.ts`'), 'bar.ts in the file map');
  const pl = c.split('\n').find((l) => l.startsWith('- `prompts/`'))!;
  for (const f of ['`bar`', '`bar-judge`']) assert.ok(pl.includes(f), f);
  assert.match(c.slice(c.indexOf('## Next up')), /quality bar \(PRD #254[^.]*are done/);
  assert.ok(read('prompts/decompose.md').includes('## Quality bar'), 'decompose prompt');
  assert.ok(read('templates/hx-skill.md').includes('## Quality bar'), 'skill template');
});

test('design.md marks roadmap #3 (gauntlet) done', () => {
  assert.match(read('docs/design.md'), /\| 3 \| ~~\*\*Gauntlet[^|]*~~ done \|/);
});

test('CLAUDE.md lists every prompt and marks #7 (inject) done', () => {
  const c = read('CLAUDE.md');
  const line = c.split('\n').find((l) => l.startsWith('- `prompts/`'))!;
  for (const f of readdirSync(path.join(root, 'prompts'))) assert.ok(line.includes(`\`${f.replace(/\.md$/, '')}\``), f);
  const next = c.slice(c.indexOf('## Next up'));
  assert.match(next, /inject \(#7[^.]*are done/);
});

test('bug lane: README section, config rows and labels, design #6 done, CLAUDE.md triage prompt and next up', () => {
  const r = read('README.md');
  const start = r.indexOf('## Bug lane');
  assert.ok(start >= 0, 'README has a Bug lane section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  for (const w of ['hx bug', '<!-- hx:triage -->', 'VERDICT: REPRODUCED', 'VERDICT: NEEDS-INFO', 'VERDICT: FAILED',
    '`bug-triaged`', '`ready-for-agent`', '`agent-blocked`', 'triageRounds', 'bugTriage', 'ahead of', 'by hand', 'PRD',
    'CI gate', 'audit']) assert.ok(sec.includes(w), w);
  assert.ok(r.includes('<!-- hx:triage -->') && r.includes('hx bug'));
  assert.ok(hasRow(r, 'bugTriage', `\`${DEFAULTS.bugTriage}\``), 'bugTriage row');
  assert.ok(hasRow(r, 'triageRounds', String(DEFAULTS.triageRounds)), 'triageRounds row');
  const labels = r.split('\n').find((l) => l.startsWith('| `labels`'))!;
  for (const l of [DEFAULTS.labels.bug, DEFAULTS.labels.triaged]) assert.ok(labels.includes(`\`${l}\``), l);
  assert.match(read('docs/design.md'), /\| 6 \| ~~\*\*Bug lane\*\*~~ done \|/);
  const c = read('CLAUDE.md');
  assert.ok(c.split('\n').find((l) => l.startsWith('- `prompts/`'))!.includes('`triage`'), 'triage among the prompts');
  const next = c.slice(c.indexOf('## Next up'));
  assert.match(next, /the bug lane \(#6[^.]*are done/);
});

test('hx help: the PRD-flow paragraph mentions the gauntlet and the security pass', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const w of ['gauntlet -> decompose -> building -> review -> security -> bar -> done', 'gauntletRounds', 'securityRounds',
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

test('skills: README section and config rows, design #5 done, .rtdd/ setup committed', () => {
  const r = read('README.md');
  const start = r.indexOf('## Skills for workers');
  assert.ok(start >= 0, 'README has a Skills for workers section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  assert.ok(hasRow(r, 'roleSkills', `\`${JSON.stringify(DEFAULTS.roleSkills)}\``), 'roleSkills row');
  assert.ok(hasRow(r, 'skillMaxChars', `\`${DEFAULTS.skillMaxChars}\``), 'skillMaxChars row');
  assert.ok(hasRow(r, 'rtddBin', `\`${JSON.stringify(DEFAULTS.rtddBin)}\``), 'rtddBin row');
  const locs = ['`<repo>/.claude/skills/x/SKILL.md`', '`<home>/.claude/skills/x/SKILL.md`', '`<repo>/.agents/skills/x/SKILL.md`'];
  const at = locs.map((l) => sec.indexOf(l));
  assert.ok(at.every((i) => i >= 0), 'skill locations');
  assert.ok(at[0] < at[1] && at[1] < at[2], 'locations in lookup order');
  for (const w of ['`{ "impl": ["rtdd"], "audit": ["rtdd"] }`', '`{}`', 'front matter', 'HTML comments', 'prompts/skills/<name>.md',
    'skillMaxChars', String(DEFAULTS.skillMaxChars), 'once per `hx run`', 'hx status', 'lean workers',
    'npx github:VocanicZ/rtdd --version=v0.4.0', 'rtdd init', 'hx init --rtdd', 'graph.json', '`rtddBin --version`',
    '`.rtdd/config.yaml` is on `origin/<base>`', '`rtdd.exe`', '`rtdd.cmd`', 'PATH', 'HX_RTDD_BIN', 'rtdd explain',
    'Round 1', 'CI gate']) assert.ok(sec.includes(w), w);
  assert.match(sec, /`ship\.mjs` runs it/); // a regex: the literal file name would mark this file as end-to-end (isolate.test.ts)
  assert.ok(sec.includes('Add a skill to a role only when an eval shows it helps'), 'eval rule');
  const d = read('docs/design.md');
  assert.match(d, /\| 5 \| ~~\*\*rtdd\*\*~~ done \|[^\n]*#34/);
  assert.match(d, /orchestrator is code and needs no skills; skills are given per role through config/);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('prompts/skills/'), 'prompts/skills/ in the file map');
  const files = spawnSync('git', ['ls-files', '.rtdd'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of ['.rtdd/config.yaml', '.rtdd/.gitignore']) assert.ok(files.includes(f), `${f} tracked`);
  assert.ok(!files.includes('.rtdd/graph.json'), 'graph.json not tracked');
  assert.match(read('.rtdd/.gitignore'), /^graph\.json$/m);
});

test('inject: README hx issue + running-fleet section with the wake and the closing lines, design #7 done, CLAUDE.md, help', () => {
  const r = read('README.md');
  for (const w of ['hx issue', '--bug', '--yes', '--title', '--file']) assert.ok(r.includes(w), w);
  const start = r.indexOf('## Adding work to a running fleet');
  assert.ok(start >= 0, 'README has an Adding work to a running fleet section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  for (const w of ['hx issue', 'hx grill', 'hx prd', 'hx bug', '.hx/wake', 'hx run --watch', 'seconds', 'this checkout',
    'CI gate', 'pause', 'usage', 'trusted',
    'hx run (pid N) will pick it up now.', 'hx run (pid N) is pausing — run  hx resume  to continue.',
    'no hx run is running — start it with  hx run --watch',
    'no hx run is running and hx is paused — run  hx resume, then  hx run --watch',
    'It will be triaged.', 'It will be decomposed into issues.']) assert.ok(sec.includes(w), w);
  const d = read('docs/design.md');
  assert.match(d, /\| 7 \| ~~\*\*Inject into a running fleet\*\*~~ done \|/);
  assert.ok(!d.includes('mostly done'), 'design.md no longer calls #7 mostly done');
  const c = read('CLAUDE.md');
  assert.ok(c.split('\n').find((l) => l.startsWith('- `prompts/`'))!.includes('`issue`'), 'issue among the prompts');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  for (const w of ['hx issue', 'issue [']) assert.ok(h.stdout.includes(w), w);
});

test('fleet dashboard: README Several repos says how to open it and what it shows; design.md records the decision', () => {
  const r = read('README.md');
  const at = r.indexOf('## Several repos');
  const sec = r.slice(at, r.indexOf('\n## ', at + 1));
  for (const w of ['hx dashboard --fleet', 'hx fleet dashboard', 'hx fleet forget', 'repos.json', 'fleet.json', 'tokens-per-day',
    'slots in use', 'hold', 'missing', 'read-only', 'localhost only', "repo's full dashboard"]) assert.ok(sec.includes(w), w);
  const d = read('docs/design.md');
  const f0 = d.indexOf('## Fleet');
  const fs = d.slice(f0, d.indexOf('\n## ', f0 + 1));
  for (const w of ['fleet dashboard', 'one server', '/repo/<k>/', 'append-only', 'never a path from the request', 'repos.json', '`hx init`', '`hx run`'])
    assert.ok(fs.includes(w), w);
});

test('fleet and agent CLIs: README sections and agentCli row, design #10 done, CLAUDE.md file map and next up', () => {
  const r = read('README.md');
  const at = r.indexOf('## Several repos');
  assert.ok(at >= 0, 'README has a Several repos section');
  const sec = r.slice(at, r.indexOf('\n## ', at + 1));
  for (const w of ['hx fleet add', 'hx fleet remove', 'hx fleet list', 'hx fleet workers', 'hx fleet run', 'hx fleet status',
    '--workers', '--watch', 'slot', 'hold.json', 'hx dashboard', '--port', 'Ctrl+C', '~/.hx/fleet.json']) assert.ok(sec.includes(w), w);
  const a = r.indexOf('## Agent CLIs');
  assert.ok(a >= 0, 'README has an Agent CLIs note');
  const agents = r.slice(a, r.indexOf('\n## ', a + 1));
  for (const w of ['AgentCli', 'src/agents/', 'claude', 'agentCli']) assert.ok(agents.includes(w), w);
  assert.ok(hasRow(r, 'agentCli', `\`${JSON.stringify(DEFAULTS.agentCli)}\``), 'agentCli row');
  // every hx fleet subcommand the README names is one the CLI knows
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  for (const m of sec.matchAll(/hx fleet (\w+)/g)) assert.ok(h.stdout.includes(`fleet ${m[1]}`), `fleet ${m[1]}`);
  const d = read('docs/design.md');
  assert.match(d, /\| 10 \| ~~\*\*Multi-repo \/ multi-CLI\*\*~~ done \|/);
  const f0 = d.indexOf('## Fleet');
  assert.ok(f0 >= 0, 'design.md has a Fleet section');
  const fs = d.slice(f0, d.indexOf('\n## ', f0 + 1));
  for (const w of ['slots', '`wx`', 'takeover', 'hold.json', 'IPC', 'detached', 'AgentCli', 'src/agents/']) assert.ok(fs.includes(w), w);
  const c = read('CLAUDE.md');
  const map = c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions'));
  for (const f of ['`fleet.ts`', '`agents/`']) assert.ok(map.includes(f), f);
  const next = c.slice(c.indexOf('## Next up'));
  assert.match(next, /multi-repo \/ multi-CLI \(#10[^.]*are done/);
  assert.doesNotMatch(next, /Next is #10/);
  // every src/ file and directory the docs name exists
  for (const doc of [r, d, c]) for (const m of doc.matchAll(/`src\/([\w./-]+)`/g)) assert.ok(existsSync(path.join(root, 'src', m[1])), `src/${m[1]}`);
});

test('README: budgetGate config row with its default and the Budget gate paragraph; design records the gate', () => {
  const r = read('README.md');
  assert.ok(hasRow(r, 'budgetGate', `\`${DEFAULTS.budgetGate}\``));
  const para = r.split(/\r?\n\r?\n/).find((p) => p.startsWith('**Budget gate:**'))?.replace(/\r?\n/g, ' ');
  assert.ok(para, 'Budget gate paragraph');
  for (const s of ['.hx/usage-readings.jsonl', 'budgetMinPairs', 'budget: not starting #12 review — needs ~7% of five_hour, 85% used, cap 90%', '`budgetGate: false`', 'too little'])
    assert.ok(para.includes(s), s);
  const at = r.indexOf('**Budget gate:**');
  assert.ok(at > r.indexOf('**Usage limits:**') && r.indexOf('**Usage limits:**') >= 0 && at < r.indexOf('## PRD flow'), 'in Stopping and resuming, after Usage limits');
  const d = read('docs/design.md');
  assert.ok(d.includes('## Budget gate'));
  const sec = d.slice(d.indexOf('## Budget gate'));
  for (const s of ['p20', 'p80', 'nearest-rank', 'impl + audit', 'critic + revise', 'usage-readings.jsonl']) assert.ok(sec.slice(0, sec.indexOf('\n## ', 5)).includes(s), s);
});

test('README: roleModels config row with its default and the Models per role section', () => {
  const r = read('README.md');
  assert.ok(hasRow(r, 'roleModels', `\`${JSON.stringify(DEFAULTS.roleModels)}\``));
  const sec = r.slice(r.indexOf('## Models per role'));
  assert.ok(r.includes('## Models per role'));
  assert.ok(sec.includes('"roleModels": { "impl": { "model": "claude-sonnet-5-5" }, "audit": { "model": "claude-sonnet-5-5", "effort": "high" } }'));
  assert.match(sec.slice(0, sec.indexOf('\n## ', 5)), /benchmark/);
});

test('worktree setup: README section and config rows, design records the decision, CLAUDE.md file map', () => {
  const r = read('README.md');
  const start = r.indexOf('## Worktree setup');
  assert.ok(start >= 0, 'README has a Worktree setup section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  assert.ok(hasRow(r, 'worktreeSetup', `\`${JSON.stringify(DEFAULTS.worktreeSetup)}\``), 'worktreeSetup row');
  assert.ok(hasRow(r, 'worktreeSetupMinutes', `\`${DEFAULTS.worktreeSetupMinutes}\``), 'worktreeSetupMinutes row');
  assert.ok(hasRow(r, 'worktreeCopy', `\`${JSON.stringify(DEFAULTS.worktreeCopy)}\``), 'worktreeCopy row');
  for (const w of ['node_modules', '`vendor/`', '`.venv`', '`.env`', 'worktreeSetup', 'worktreeSetupMinutes', 'worktreeCopy',
    '`..`', 'glob', 'absolute', 'tracked by git', 'info/exclude', 'impl', 'audit', 'triage', 'gate', 'did not succeed',
    'hx init', 'pnpm-lock.yaml', 'package-lock.json', 'npm ci', 'Cargo.lock', '`""`', 'setup note', '3 times', 'red',
    '.hx/logs/setup-<name>.log', 'setup-<name>.json', 'setup FAILED', 'frozen']) assert.ok(sec.includes(w), w);
  const d = read('docs/design.md');
  assert.ok(d.includes('worktreeSetup'), 'design.md mentions worktreeSetup');
  const ds = d.slice(d.indexOf('## Worktree setup'), d.indexOf('\n## ', d.indexOf('## Worktree setup') + 1));
  for (const w of ['queue', 'per-directory', 'gateCheck', 'sha', 'info/exclude', 'cache']) assert.ok(ds.includes(w), w);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('`setup.ts`'), 'setup.ts in the file map');
});

test('CI gate: gateMinutes config row with its default, and the CI gate section names it (#180)', () => {
  const r = read('README.md');
  assert.ok(hasRow(r, 'gateMinutes', `\`${DEFAULTS.gateMinutes}\``), 'gateMinutes row');
  const start = r.indexOf('## CI gate');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  assert.ok(sec.includes('`gateMinutes` (default 45)'), sec);
  assert.ok(sec.includes('`--test-timeout` minutes (default 45'), sec);
});

test('GitHub rate limits: README paragraph, ghReservePct row, Files entry, design decision, CLAUDE.md (#173)', () => {
  const r = read('README.md');
  assert.ok(hasRow(r, 'ghReservePct', String(DEFAULTS.ghReservePct)), 'ghReservePct row');
  assert.equal(DEFAULTS.ghReservePct, 0.2);
  const row = r.split('\n').find((l) => l.startsWith('| `ghReservePct`'))!;
  for (const w of ['0..1', '0 = off']) assert.ok(row.includes(w), w);
  const at = r.indexOf('**GitHub rate limits:**');
  assert.ok(at >= 0 && at < r.indexOf('## PRD flow'), 'GitHub rate limits paragraph in Stopping and resuming');
  const para = r.slice(at, r.indexOf('\n\n', at));
  for (const w of ['one `gh` login', 'gh api rate_limit', '`github` line', '`hx status`', 'dashboard', '`hx fleet status`',
    'ghReservePct', '2 × `pollSeconds`', 'Retry-After', 'HX_GH_WAIT_MAX_SECONDS', '(default 90)', 'github-hold.json',
    'github rate limited — waiting until 22:41', 'rate limited until 22:41', 'fails at once']) assert.ok(para.includes(w), w);
  // the log lines quoted in the README are the ones the code prints
  const pool = read('src/pool.ts');
  for (const l of ['github rate limited — waiting until ', 'github budget low: ', ' — no new claims until ', 'github budget restored']) assert.ok(pool.includes(l), l);
  assert.ok(read('scripts/ghwait.mjs').includes('rate limited until ') && read('scripts/ghwait.mjs').includes(': 90)'));
  assert.ok(read('src/ghlimit.ts').includes('`github   core '));
  assert.ok(r.includes('`github budget low: graphql 812/5000 — no new claims until 22:41`'));
  assert.ok(r.includes('github   core 4123/5000, graphql 4800/5000 (resets 22:41)'));
  const files = r.slice(r.indexOf('## Files'), r.indexOf('\n## ', r.indexOf('## Files') + 1));
  assert.ok(read('src/fleet.ts').includes("path.join(dir, 'github-hold.json')"));
  for (const f of ['`~/.hx/fleet/hold.json`', '`~/.hx/fleet/github-hold.json`']) assert.ok(files.includes(f), f);
  const d = read('docs/design.md');
  const ds = d.slice(d.indexOf('## GitHub rate limits'), d.indexOf('\n## ', d.indexOf('## GitHub rate limits') + 1));
  assert.ok(d.includes('## GitHub rate limits'), 'design section');
  for (const w of ['ghReservePct', 'wait signal', '`hx run`', '--dry-run', '90 s', 'Bash tool', 'github-hold.json', 'one account']) assert.ok(ds.includes(w), w);
  assert.match(d, /\| 7 \| GitHub rate limits[^\n]*\| done \|/);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('`ghlimit.ts`'), 'ghlimit.ts in the file map');
});

test('releases: README section, config rows, help, CONTRIBUTING steps, design decisions, CLAUDE.md (#188)', () => {
  const r = read('README.md');
  const start = r.indexOf('## Releases');
  assert.ok(start >= 0, 'README has a Releases section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  for (const w of ['hx release [patch|minor|major] [--dry-run] [--yes]', '`vX.Y.Z`', 'package.json', '`0.0.0`', 'minor', 'patch',
    'major', 'by hand', 'gateCommand', '`gate` is off', 'gate.json', '--atomic', 'no rebase', 'not bumped', 'gated commit',
    'no GitHub release', 'created the missing release', 'PRD #', '## Features', '## Fixes', '## Docs', '## Other', '(#issue, #PR)',
    'Full diff', 'compare', 'no AI', 'no changelog file', 'autoRelease', 'autoReleasePatchHours', '`fix:`',
    'released v1.4.0 (PRD #139)', 'released v1.4.1 (fixes)', 'release: none due', 'nothing to release', 'already running for this repo (pid', 'exit 3'])
    assert.ok(sec.includes(w), w);
  // the log lines quoted are the ones the code prints
  const rel = read('src/release.ts'), pool = read('src/pool.ts');
  for (const l of ['created the missing release ', 'nothing to release since ', 'package.json was not bumped (push rejected)', 'no gate command known: set gateCommand'])
    assert.ok(rel.includes(l) && sec.includes(l.trim()), l);
  for (const l of ['released ${r.released} (', "'fixes'", 'release: none due — ']) assert.ok(pool.includes(l), l);
  assert.ok(hasRow(r, 'autoRelease', `\`${DEFAULTS.autoRelease}\``), 'autoRelease row');
  assert.ok(hasRow(r, 'autoReleasePatchHours', String(DEFAULTS.autoReleasePatchHours)), 'autoReleasePatchHours row');
  const usage = r.slice(r.indexOf('## Usage'), r.indexOf('\n## ', r.indexOf('## Usage') + 1));
  assert.ok(usage.includes('hx release'), 'hx release in the Usage listing');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  for (const w of ['release [patch|minor|major] [--dry-run] [--yes]', 'autoRelease']) assert.ok(h.stdout.includes(w), w);
  const ct = read('CONTRIBUTING.md');
  const cs = ct.slice(ct.indexOf('## Releases'), ct.indexOf('\n## ', ct.indexOf('## Releases') + 1));
  assert.ok(cs.includes('hx release'), 'CONTRIBUTING uses hx release');
  for (const w of ['gh release create', 'git tag -a', 'Set `version` in `package.json`']) assert.ok(!cs.includes(w), `no manual step: ${w}`);
  const d = read('docs/design.md');
  const d0 = d.indexOf('## Releases');
  assert.ok(d0 >= 0, 'design.md has a Releases section');
  const ds = d.slice(d0, d.indexOf('\n## ', d0 + 1));
  for (const w of ['PRD #139', 'gated commit', 'No rebase', 'Nothing stored', 'gate.json', '`hx run`', 'autoRelease', 'no AI']) assert.ok(ds.includes(w), w);
  assert.match(d, /\| 8 \| Releases[^\n]*\| done \|/);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('`release.ts`'), 'release.ts in the file map');
});

test('onboarding: README npx install before the clone path and a First run section, help, CLAUDE.md, design (#214)', () => {
  const r = read('README.md');
  const npx = r.indexOf('npx github:MorphEdit/Hx install'), clone = r.indexOf('git clone https://github.com/MorphEdit/Hx');
  assert.ok(npx >= 0 && clone >= 0 && npx < clone, 'npx install line before the clone path');
  assert.ok(npx < r.indexOf('hx start'), 'then hx start');
  const install = r.slice(r.indexOf('## Install'), r.indexOf('\n## ', r.indexOf('## Install') + 1));
  assert.ok(!install.includes('git clone') && !install.includes('npm link\n'), 'the clone path is not in Install');
  const dev = r.slice(r.indexOf('## Development'), r.indexOf('\n## ', r.indexOf('## Development') + 1));
  for (const w of ['git clone https://github.com/MorphEdit/Hx', 'npm link']) assert.ok(dev.includes(w), `Development: ${w}`);
  const at = r.indexOf('## First run');
  assert.ok(at >= 0, 'README has a First run section');
  const sec = r.slice(at, r.indexOf('\n## ', at + 1));
  for (const w of ['hx start', '✓', '✗', '–', '?', 'init: no .hx/config.json — running hx init', 'PRD: grilling the idea', 'plan:',
    'Start 2 worker(s) now? [Y/n]', 'run: hx run --watch', '--yes', 'hx doctor']) assert.ok(sec.includes(w), w);
  // the lines quoted are the ones the code prints
  const cli = read('src/cli.ts');
  for (const l of ["'\\ninit: no .hx/config.json — running hx init'", "'\\nPRD: grilling the idea'", "'\\nplan:'", 'Start ${workers} worker(s) now? [Y/n] ', 'run: hx run --watch --workers '])
    assert.ok(cli.includes(l), l);
  const usage = r.slice(r.indexOf('## Usage'), r.indexOf('\n## ', r.indexOf('## Usage') + 1));
  for (const w of ['hx start', 'hx doctor', 'hx update', 'hx install-skill', '/hx', 'hx --version']) assert.ok(usage.includes(w), `Usage: ${w}`);
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  for (const w of ['\n  doctor ', '\n  start ', '\n  update ', '\n  install-skill ', '\n  --version ']) assert.ok(h.stdout.includes(w), w.trim());
  const ct = read('CONTRIBUTING.md');
  for (const w of ['git clone https://github.com/MorphEdit/Hx', 'npm link']) assert.ok(ct.includes(w), `CONTRIBUTING: ${w}`);
  const c = read('CLAUDE.md');
  const map = c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions'));
  for (const w of ['src/doctor.ts', '`doctor.ts`', '`templates/`', 'hx-skill.md', '`bin/`', 'install.mjs', 'strip-hook.mjs']) assert.ok(map.includes(w), w);
  const d = read('docs/design.md');
  const d0 = d.indexOf('## Onboarding');
  assert.ok(d0 >= 0, 'design.md has an Onboarding section');
  const ds = d.slice(d0, d.indexOf('\n## ', d0 + 1));
  for (const w of ['github:', 'no registry', 'before any `.ts` loads', 'registerHooks', 'stripTypeScriptTypes', 'node_modules', 'no build',
    '`✓`', '`✗`', '`–`', '`?`', 'startup gate', '`hx start`', 'templates/hx-skill.md']) assert.ok(ds.includes(w), w);
  assert.match(d, /\| 9 \| Onboarding[^\n]*\| done \|/);
});

test('test time: README Where the time goes, gate-runs.jsonl, testPatterns, design.md, CLAUDE.md (#207)', () => {
  const r = read('README.md');
  const at = r.indexOf('## Where the time goes');
  assert.ok(at >= 0, 'README has a Where the time goes section');
  const sec = r.slice(at, r.indexOf('\n## ', at + 1));
  for (const w of ['Bash', 'testPatterns', 'gateCommand', 'node scripts/check.mjs', 'testMs', 'testRuns', 'testFailedRuns',
    'hx usage --tests', 'hx usage', 'hx status', 'time     tests', 'dashboard', 'gate is slow', 'gate-runs.jsonl']) assert.ok(sec.includes(w), w);
  assert.ok(hasRow(r, 'testPatterns', `\`${JSON.stringify(DEFAULTS.testPatterns)}\``), 'testPatterns config row');
  const files = r.slice(r.indexOf('## Files'), r.indexOf('\n## ', r.indexOf('## Files') + 1));
  for (const w of ['.hx/gate-runs.jsonl', '{ ts, sha, ok, durationMs, timedOut }', 'release gate']) assert.ok(files.includes(w), `Files: ${w}`);
  const d = read('docs/design.md');
  const d0 = d.indexOf('## Test time');
  assert.ok(d0 >= 0, 'design.md has a Test time section');
  const ds = d.slice(d0, d.indexOf('\n## ', d0 + 1));
  for (const w of ['stream-json', 'wall clock', 'no new hooks', 'tokens']) assert.ok(ds.includes(w), w);
  const c = read('CLAUDE.md');
  assert.ok(c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions')).includes('`timing.ts`'), 'timing.ts in the file map');
});

test('self-check: README section, config rows, files, models per role, design.md section, CLAUDE.md, help', () => {
  const r = read('README.md');
  const start = r.indexOf('## Self-check');
  assert.ok(start >= 0, 'README has a Self-check section');
  const sec = r.slice(start, r.indexOf('\n## ', start + 1));
  for (const w of ['hx health', '--fix', 'hx run --watch', 'healthEveryMinutes', 'selfHeal: false', 'usage hold', 'GitHub budget',
    '<!-- hx:health resume -->', '<!-- hx:health unblock <time> -->', '<!-- hx:health <key> -->', '`health:`', 'never refiled',
    '.hx/selfreview.json', '<!-- hx:selfreview <sha> -->', 'selfReviewMaxFindings', 'selfReviewEveryHours', 'roleModels.selfreview',
    'bug lane', 'hx status', 'dashboard', 'run log', 'NEEDS-INFO', 'force', 'main', 'remote branch', 'local branch'])
    assert.ok(sec.includes(w), w);
  // the checks in pass order
  const order = ['**Stale PR**', '**Blocked after a passed audit**', '**Gate-fix issue on a green main**', '**Blocked by a transient error**',
    '**Leftover worktrees**', '**Stuck labels**', '**Environment**'].map((w) => sec.indexOf(w));
  assert.ok(order.every((i) => i >= 0), 'every check named');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'checks in pass order');
  for (const k of ['selfHeal'] as const) assert.ok(hasRow(r, k, `\`${DEFAULTS[k]}\``), k);
  for (const k of ['healthEveryMinutes', 'selfReviewEveryHours', 'selfReviewMaxFindings'] as const) assert.ok(hasRow(r, k, String(DEFAULTS[k])), k);
  const usage = r.slice(r.indexOf('## Usage'), r.indexOf('\n## ', r.indexOf('## Usage') + 1));
  assert.ok(usage.includes('hx health [--fix]'), 'hx health in Usage');
  const files = r.slice(r.indexOf('## Files'), r.indexOf('\n## ', r.indexOf('## Files') + 1));
  for (const f of ['`.hx/health.json`', '`.hx/selfreview.json`']) assert.ok(files.includes(f), f);
  const models = r.slice(r.indexOf('## Models per role'), r.indexOf('\n## ', r.indexOf('## Models per role') + 1));
  assert.ok(models.includes('`selfreview`'), 'selfreview in Models per role');
  const d = read('docs/design.md');
  const ds = d.indexOf('## Self-check (PRD #194)');
  assert.ok(ds >= 0, 'design.md has the Self-check section');
  const dEnd = d.indexOf('\n## ', ds + 1);
  const dsec = d.slice(ds, dEnd < 0 ? undefined : dEnd);
  for (const w of ['src/health.ts', 'snapshot', 'gate-runs.jsonl', 'Twice green', 'marker', 'selfHeal: false', 'second resume'])
    assert.ok(dsec.includes(w), w);
  const c = read('CLAUDE.md');
  const map = c.slice(c.indexOf('## Where things are'), c.indexOf('## Conventions'));
  assert.ok(map.includes('`health.ts`'), 'health.ts in the file map');
  assert.ok(existsSync(path.join(root, 'prompts', 'selfreview.md')), 'prompts/selfreview.md exists');
  assert.ok(c.split('\n').find((l) => l.startsWith('- `prompts/`'))!.includes('`selfreview`'), 'selfreview among the prompts');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.ok(h.stdout.includes('health [--fix]'), 'hx help names hx health [--fix]');
});

test('self-update: README paragraph in Stopping and resuming, config rows, Files entry, design decision, CLAUDE.md (#253)', () => {
  const r = read('README.md'), d = read('docs/design.md'), c = read('CLAUDE.md');
  const stop = r.slice(r.indexOf('## Stopping and resuming'), r.indexOf('\n## ', r.indexOf('## Stopping and resuming') + 1));
  for (const w of ['**Self-update:**', 'selfUpdateMinutes', 'git merge --ff-only', 'prompts/', 'hx update', '120 s', 'rolled back',
    'git checkout <old sha>', 'self-update: restarted', 'self-update: rolled back to', 'hx status', 'hx fleet run']) assert.ok(stop.includes(w), `Stopping and resuming: ${w}`);
  assert.ok(hasRow(r, 'selfUpdate', `\`${DEFAULTS.selfUpdate}\``), 'selfUpdate row');
  assert.ok(hasRow(r, 'selfUpdateMinutes', String(DEFAULTS.selfUpdateMinutes)), 'selfUpdateMinutes row');
  const files = r.slice(r.indexOf('## Files'), r.indexOf('\n## ', r.indexOf('## Files') + 1));
  assert.ok(files.includes('.hx/selfupdate.json'), 'Files: .hx/selfupdate.json');
  assert.ok(d.includes('## Self-update (#253)'), 'design: Self-update');
  assert.ok(c.includes('`selfupdate.ts`'), 'CLAUDE.md names selfupdate.ts');
});

test('self-update watch window: a paragraph in Stopping and resuming, its two config rows (#316)', () => {
  const r = read('README.md');
  const stop = r.slice(r.indexOf('## Stopping and resuming'), r.indexOf('\n## ', r.indexOf('## Stopping and resuming') + 1));
  for (const w of ['**The watch window:**', 'selfUpdateWatchMinutes', 'selfUpdateFailLimit', 'hx supervise', 'hx pause --now',
    'self-update: rolled back 9b8e7d6 → 3f2a1c0', 'is good', 'watching 9b8e7d6 for 12 more min',
    'it exits non-zero', 'rolls itself back', '.hx/exit.json']) assert.ok(stop.includes(w), `Stopping and resuming: ${w}`);
  assert.ok(hasRow(r, 'selfUpdateWatchMinutes', String(DEFAULTS.selfUpdateWatchMinutes)), 'selfUpdateWatchMinutes row');
  assert.ok(hasRow(r, 'selfUpdateFailLimit', String(DEFAULTS.selfUpdateFailLimit)), 'selfUpdateFailLimit row');
});

test('needs-human: README maxOpenQuestions row and needs-human label', () => {
  const r = docsText();
  assert.ok(hasRow(r, 'maxOpenQuestions', String(DEFAULTS.maxOpenQuestions)), 'maxOpenQuestions row');
  const labels = r.split('\n').find((l) => l.startsWith('| `labels`'))!;
  assert.ok(labels.includes(`\`${DEFAULTS.labels.needsHuman}\``) && labels.includes('`needsHuman`'), 'needsHuman label');
});

test('needs-human: README has a "When hx needs you" section for the owner; hx help names needs-human', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const at = readme.indexOf('## When hx needs you');
  assert.ok(at >= 0, 'README: When hx needs you');
  const s = readme.slice(at, readme.indexOf('\n## ', at + 1));
  for (const w of ['`needs-human`', '`maxOpenQuestions`', '`## Decisions made for you`', '`## Owner decisions`', 'Hx needs your answer:',
    'secret', '`done`', 'hx status', 'Waiting on you']) assert.ok(s.includes(w), `When hx needs you: ${w}`);
  const g = readFileSync(path.join(root, 'docs/guide.md'), 'utf8');
  const outcomes = g.slice(g.indexOf('## What happens to an issue'), g.indexOf('\n## ', g.indexOf('## What happens to an issue') + 1));
  assert.ok(outcomes.includes('`needs-human`'), 'What happens to an issue: needs-human');
  const help = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /needs-human/);
  assert.match(help, /comment on its issue/);
});

test('size check: the guide documents it in Single issues, the split-up-front row and the sizeCheck row; hx help names sizeCheck', () => {
  const r = read('README.md');
  const start = r.indexOf('## Single issues');
  assert.ok(start >= 0, 'a Single issues section');
  const sec = r.slice(start, r.indexOf('\n## When a task needs you', start)); // its markdown example holds a `## Blocked by` line
  for (const w of ['size check', '`size`', '`decompose`', 'SIZE: fits', 'SIZE: split', '30–45 min', '<!-- hx-size fits -->',
    '<!-- hx-size split -->', '`size #n: fits`', '`split #n → #a, #b`', 'not planned', 'treated\n  as fits', 'trustedAuthors',
    '`bug`', '`hx-gate-fix`', 'sizeCheck: false']) assert.ok(sec.includes(w), w);
  assert.ok(r.split('\n').some((l) => l.startsWith('| split up front')), 'What happens to an issue: split up front');
  assert.ok(hasRow(r, 'sizeCheck', `\`${DEFAULTS.sizeCheck}\``), 'sizeCheck row');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  const run = h.stdout.slice(h.stdout.indexOf('  run [options]'), h.stdout.indexOf('  supervise'));
  assert.match(run, /sized first and split into children when too big: sizeCheck/);
});

test('guide: a Config table row for each autoWorkers key with its default (#319)', () => {
  const g = read('docs/guide.md');
  assert.ok(hasRow(g, 'autoWorkers', `\`${DEFAULTS.autoWorkers}\``), 'autoWorkers');
  for (const k of ['minWorkers', 'loadHighPct', 'loadLowPct', 'minFreeMemGB', 'scaleUpMinutes'] as const) assert.ok(hasRow(g, k, String(DEFAULTS[k])), k);
});

test('split after a timeout: the guide documents it in Single issues and the two rows; hx help names it (#312)', () => {
  const r = read('README.md');
  const start = r.indexOf('## Single issues');
  const sec = r.slice(start, r.indexOf('\n## When a task needs you', start));
  for (const w of ['split after a timeout', '`after-timeout`', 'SIZE: narrow', '=== SCOPE', '`## Scope (narrowed after a timeout)`',
    '<!-- hx-size narrowed -->', '(narrowed after a timeout)`', 'the turn timed out again; this issue was already split once after a timeout',
    '`git diff origin/<base>...HEAD`']) assert.ok(sec.includes(w), w);
  const rows = r.split('\n');
  assert.ok(rows.some((l) => l.startsWith('| the impl turn timed out') && /checkpoint and push/.test(l) && /narrowed/.test(l)
    && /rest filed/.test(l) && /`ready-for-agent` again/.test(l)), 'What happens to an issue: the impl turn timed out');
  assert.ok(rows.some((l) => l.startsWith('| a second timeout') && l.includes('`agent-blocked`')), 'What happens to an issue: a second timeout');
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  const run = h.stdout.slice(h.stdout.indexOf('  run [options]'), h.stdout.indexOf('  supervise'));
  assert.match(run, /timed-out impl turn is pushed, its issue narrowed and the rest filed/);
});

test('guide: the Auto-scaled workers section; hx help: --workers is the most sessions at once, fewer while busy (#320)', () => {
  const g = read('docs/guide.md');
  const start = g.indexOf('## Auto-scaled workers');
  assert.ok(start >= 0, 'the section');
  const sec = g.slice(start, g.indexOf('\n## ', start + 1));
  for (const w of ['ceiling', '`minWorkers`', '--workers N', 'every 5 s', '60 s', '`loadHighPct`', '`loadLowPct`', '`minFreeMemGB`',
    '`scaleUpMinutes`', 'The gate counts as one', 'workers: 3 → 2 (cpu 91%, free 7.9 GB)', 'workers: 2 → 3', '"autoWorkers": false',
    'never stopped', 'clamps the floor', 'HX_AUTO_WORKERS=0', 'autoWorkers: { target, cpuPct, freeMemGB }'])
    assert.ok(sec.includes(w), w);
  const h = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' }).stdout;
  assert.match(h, /--workers N +the most sessions at once \(default: config\.workers\); fewer while the machine is\s+busy when autoWorkers is on/);
  assert.match(h, /--workers N: passed on, the most\s+sessions at once as for hx run/);
  assert.match(h, /fewer while the machine is busy\s+when autoWorkers is on/);
});

test('docs/benchmark.md: the Test suite speed section, outside the Project benchmark table, with the runs, per test and per file rows (#354)', () => {
  const b = read('docs/benchmark.md');
  const at = b.indexOf('\n## Test suite speed\n');
  assert.ok(at >= 0, 'docs/benchmark.md has a Test suite speed section');
  assert.ok(b.indexOf('<!-- project-bench:end -->') < at || b.indexOf('<!-- project-bench:start -->') > at, 'outside the table figures.mjs regenerates');
  const next = b.indexOf('\n## ', at + 1);
  const sec = b.slice(at, next < 0 ? undefined : next);
  for (const s of ['npm run test:profile -- --test-concurrency=', '`workers` line', '**Per test**', '**Per file**', '| PR |', 'Why not more'])
    assert.ok(sec.includes(s), s);
  // each table row names its PR, so a later PR appends rows without rewriting these
  const rows = sec.split('\n').filter((l) => /^\| #354 \|/.test(l));
  assert.equal(rows.length, 1 + 21 + 5, 'one run row, the 20 tests and their sum, the 5 files');
  assert.ok(rows.every((l) => l.split('|').length >= 7), rows.join('\n'));
});
