// hx install-skill: the real CLI writes templates/hx-skill.md to <HX_SKILLS_HOME>/.claude/skills/hx/SKILL.md.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const HX = path.join(root, 'bin', 'hx.mjs');
const TEMPLATE = path.join(root, 'templates', 'hx-skill.md');

function hx(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: mkdtempSync(path.join(os.tmpdir(), 'hx-isk-cwd-')),
    encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\r\n/g, '\n') };
}

test('hx install-skill writes the template to <HX_SKILLS_HOME>/.claude/skills/hx/SKILL.md, not the real home', E2E, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-'));
  const fakeOsHome = mkdtempSync(path.join(os.tmpdir(), 'hx-isk-os-'));
  const r = hx(['install-skill'], { HX_SKILLS_HOME: home, HOME: fakeOsHome, USERPROFILE: fakeOsHome });
  assert.equal(r.code, 0, r.out);
  const file = path.join(home, '.claude', 'skills', 'hx', 'SKILL.md');
  assert.equal(r.out.trim(), file);
  assert.equal(readFileSync(file, 'utf8'), readFileSync(TEMPLATE, 'utf8'));
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
  assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), readFileSync(TEMPLATE, 'utf8'));
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

test('hx help lists install-skill', () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^ {2}install-skill /m);
});
