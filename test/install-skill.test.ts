// hx install-skill: the real CLI writes templates/hx-skill.md, {{TIERS}} rendered, to <HX_SKILLS_HOME>/.claude/skills/hx/SKILL.md.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../src/skills.ts';
import { tierNumberRegex, tierTable } from '../src/tiers.ts';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const HX = path.join(root, 'bin', 'hx.mjs');
const TEMPLATE = path.join(root, 'templates', 'hx-skill.md');
const SIZING = 'Sizing: keep one issue to about 30–45 min of work for one session; split anything bigger.';
/** What install-skill writes: the template with {{TIERS}} replaced by tierTable(). */
const rendered = () => readFileSync(TEMPLATE, 'utf8').replace('{{TIERS}}', () => tierTable());

function hx(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: mkdtempSync(path.join(os.tmpdir(), 'hx-isk-cwd-')),
    encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\r\n/g, '\n') };
}

test('hx install-skill writes the rendered template to <HX_SKILLS_HOME>/.claude/skills/hx/SKILL.md, not the real home', E2E, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-'));
  const fakeOsHome = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-os-'));
  const r = hx(['install-skill'], { HX_SKILLS_HOME: home, HOME: fakeOsHome, USERPROFILE: fakeOsHome });
  assert.equal(r.code, 0, r.out);
  const file = path.join(home, '.claude', 'skills', 'hx', 'SKILL.md');
  assert.equal(r.out.trim(), file);
  assert.equal(readFileSync(file, 'utf8'), rendered());
  assert.deepEqual(readdirSync(fakeOsHome), [], 'the OS home is never touched');
});

test('hx install-skill twice: one file, the same content; an existing file is overwritten, not appended to', E2E, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-'));
  const dir = path.join(home, '.claude', 'skills', 'hx');
  assert.equal(hx(['install-skill'], { HX_SKILLS_HOME: home }).code, 0);
  writeFileSync(path.join(dir, 'SKILL.md'), 'stale copy\n');
  const r = hx(['install-skill'], { HX_SKILLS_HOME: home });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(dir), ['SKILL.md']);
  assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), rendered());
});

test('the /hx skill template: front matter, hx doctor / init / prd / run --watch, never gh auth login', () => {
  const t = readFileSync(TEMPLATE, 'utf8');
  assert.match(t, /^---\r?\nname: hx\r?\ndescription: .*build.*with hx/);
  for (const s of ['hx doctor', 'hx init', '.hx/config.json', 'hx prd <file>', 'hx run --watch']) assert.ok(t.includes(s), s);
  assert.match(t, /Never run `gh auth login`/);
  assert.match(t, /never log in .*for the user/);
  // the same interview as prompts/grill.md
  const grill = readFileSync(path.join(root, 'prompts', 'grill.md'), 'utf8');
  for (const q of ['the problem and goals;', 'the scope and explicit non-goals;', 'the user-facing behaviour;',
    'acceptance criteria a test can check;', 'edge cases and error handling;', 'constraints from the existing code.',
    'one question at a time']) {
    assert.ok(grill.includes(q) && t.includes(q), q);
  }
});

test('installSkill into a temp home: SKILL.md holds tierTable() and no leftover {{TIERS}}', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-'));
  const file = installSkill(home);
  assert.equal(file, path.join(home, '.claude', 'skills', 'hx', 'SKILL.md'));
  const out = readFileSync(file, 'utf8');
  assert.ok(out.includes(tierTable()), 'the tier table');
  assert.ok(!out.includes('{{TIERS}}'), 'no placeholder left');
  assert.ok(readFileSync(TEMPLATE, 'utf8').includes('{{TIERS}}'), 'the template keeps the placeholder');
});

test('the skill template: {{TIERS}} and no tier number of its own outside it and the exact sizing line', () => {
  const t = readFileSync(TEMPLATE, 'utf8');
  assert.ok(t.includes('{{TIERS}}'));
  assert.ok(t.includes(SIZING), 'the sizing line, word for word');
  const rest = t.split('{{TIERS}}').join('').split(SIZING).join('');
  assert.equal(rest.match(tierNumberRegex()), null, String(rest.match(tierNumberRegex())));
});

/** The text of the `## <heading>` section, up to the next `## ` heading. */
function section(t: string, heading: string): string {
  const i = t.indexOf(`\n## ${heading}`);
  assert.ok(i >= 0, heading);
  const j = t.indexOf('\n## ', i + 1);
  return t.slice(i, j < 0 ? undefined : j);
}

test('the skill template: the tier step comes first, stating the tier, the reason and both estimates before anything else', () => {
  const t = readFileSync(TEMPLATE, 'utf8');
  const tier = t.indexOf('Pick the tier');
  assert.ok(tier > 0 && tier < t.indexOf('## 1. Check the machine'), 'the tier step is before Check the machine');
  assert.ok(t.indexOf('## ') === t.indexOf('## 0. Pick the tier'), 'it is the first step');
  const s = section(t, '0. Pick the tier');
  assert.match(s, /before anything else: no `hx doctor`, no `hx init`, no file written/);
  assert.ok(s.indexOf('{{TIERS}}') > 0);
  for (const w of ['the tier you pick', 'the reason', 'a rough direct estimate and a rough fleet estimate', 'minutes and dollars',
    'Say they are rough', 'a guess']) assert.ok(s.includes(w), w);
  // the tier is stated before the machine is checked or anything is set up
  assert.ok(t.indexOf('hx doctor`. If') > t.indexOf('the tier you pick'));
});

test('the skill template: overrides, unattended requests, One child or Fleet settings', () => {
  const s = section(readFileSync(TEMPLATE, 'utf8'), '0. Pick the tier');
  assert.match(s, /The user decides\. An override in either direction is followed/);
  assert.match(s, /unattended[^]*do not offer Direct: the\s+choice is between One child and Fleet/);
  for (const w of ['`singleChildMaxCriteria`', '`workers`', '`autoWorkers`', 'do not edit `.hx/config.json` unless they ask'])
    assert.ok(s.includes(w), w);
});

test('the skill template: the Direct path — no init / PRD / run, overlap twice where hx runs, hx issue on exit 1, rtdd, the PR line', () => {
  const d = section(readFileSync(TEMPLATE, 'utf8'), 'The Direct path');
  assert.match(d, /Run no `hx init`, write no PRD and run no `hx run`/);
  assert.match(d, /`\.hx\/config\.json`[^]*Not there: run no `hx` command at all \(no `hx doctor`, no `hx init`\) and no overlap check/);
  const first = d.indexOf('`hx overlap <the files you expect to change>`');
  const change = d.indexOf('**Make the change.**');
  const second = d.indexOf('`git diff --name-only <base branch>`');
  const pr = d.indexOf('**Open a PR**');
  assert.ok(first > 0 && first < change && change < second && second < pr, 'overlap → change → overlap again → PR');
  assert.match(d, /before changing anything/);
  assert.match(d, /before committing\*\* \(only where `\.hx\/config\.json` exists\)/);
  assert.match(d, /Exit code 1: do not make the change\. File the work with `hx issue` instead, and tell the user which issue\s+or PR overlaps/);
  assert.match(d, /On exit code 1, do not commit or push: file the work with\s+`hx issue`/);
  assert.match(d, /Exit code 2: tell the user the check failed, and do not commit/);
  assert.match(d, /Branch from the base branch/);
  assert.ok(d.includes('`rtdd which`') && d.includes('Not the full suite'), 'rtdd which, not the full suite');
  assert.ok(d.includes('`Direct fix: fits one session`'));
  assert.match(d, /Merge it only once its checks pass and the user agrees/);
});

test('the skill template: the Rules allow the accepted Direct path and forbid committing worker work', () => {
  const t = readFileSync(TEMPLATE, 'utf8');
  const rules = section(t, 'Rules');
  assert.ok(!rules.includes('Never commit, push or merge the feature yourself'), 'the old flat rule is gone');
  assert.match(rules, /Commit, push and merge yourself only on the Direct path the user accepted/);
  assert.match(rules, /Never commit, push or merge work\s+filed for the workers \(a PRD, or an issue filed with `hx issue`\)/);
  // the opening no longer says flatly that the session never builds the feature
  const intro = t.slice(t.indexOf('# hx'), t.indexOf('## 0.'));
  assert.ok(!intro.includes('You do not build'), intro);
  assert.match(intro, /On the Direct path only, you build the change yourself/);
});

test('docs: the tiers, the Direct path with hx overlap twice, the hx issue fallback, the PR line and the commit rule', () => {
  const d = docsText();
  for (const w of ['## The hx skill: tiers and the Direct path', '| **Direct** |', '| **One child** |', '| **Fleet** |', '`src/tiers.ts`',
    'provisional', '`{{TIERS}}`', 'next `hx install-skill`', 'override either way', 'unattended request Direct is not offered',
    '(#checking-for-overlap-hx-overlap)', 'before changing anything', '`git diff --name-only <base branch>`', 'files the work with `hx issue`',
    '`rtdd which`', '`Direct fix: fits one session`', 'only once its checks pass and you\nagree',
    'commits, pushes and merges only on the Direct path you accepted', 'never\nwork filed for the workers']) assert.ok(d.includes(w), w);
});

test('hx help lists install-skill', () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^ {2}install-skill /m);
});
