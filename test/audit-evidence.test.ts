// #233: audits read the whole change in context and show their evidence for every criterion; the implementer
// reads the parent PRD and the design before coding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

test('audit prompt: reads the parent PRD, the full changed files, the callers and the design / README', () => {
  const p = prompt('audit');
  assert.match(p, /parent PRD \("Part of PRD #N"\)/);
  assert.match(p, /read the parent PRD the same way \(`--issue N`\)/);
  assert.match(p, /the full diff: `git diff origin\/\{\{BASE\}\}\.\.\.HEAD`/);
  assert.match(p, /every changed file in full, not only the hunks/);
  assert.match(p, /the callers of the changed functions and the code they call, found with `grep`/);
  assert.match(p, /the parts of `CLAUDE\.md`, `docs\/design\.md` and the README that the change touches/);
});

test('audit prompt: the design, docs / hx help and error-path checks', () => {
  const p = prompt('audit');
  assert.match(p, /the change fits the design \(`docs\/design\.md`, `CLAUDE\.md`\) and does not break the other callers/);
  assert.match(p, /the docs \(README, `docs\/design\.md`\) and `hx help` were updated where behaviour changed/);
  assert.match(p, /Run each new or changed error path by hand and check it behaves as the issue says/);
});

test('audit prompt: a PASS lists evidence for every criterion; "none" and "read only what you need" are gone', () => {
  const p = prompt('audit');
  assert.match(p, /On a PASS, FINDINGS lists every acceptance criterion with its evidence: the file and line, the command you ran and what it printed/);
  assert.match(p, /A PASS with no evidence \(or FINDINGS "none"\) is not a PASS/);
  assert.match(p, /- <criterion> — <file:line> — <command you ran> → <what it printed> \(PASS: one line per acceptance criterion\)/);
  assert.match(p, /On a FAIL, FINDINGS lists the defects/);
  assert.doesNotMatch(p, /read only what you need/);
  assert.doesNotMatch(p, /"none" for PASS/);
  // kept
  assert.match(p, /VERDICT: PASS \(or: VERDICT: FAIL\)/);
  assert.match(p, /FAIL only for a real defect against the issue/);
  assert.match(p, /Not for style, naming, or extras the issue did not ask for/);
  assert.match(p, /Run only the affected tests/);
});

test('impl prompt: reads the parent PRD and docs/design.md / CLAUDE.md before coding', () => {
  const p = prompt('impl');
  assert.match(p, /Before coding, read the parent PRD named on its first line \("Part of PRD #N": the same script with `--issue N`\)/);
  assert.match(p, /the parts of `docs\/design\.md` and `CLAUDE\.md` that the issue touches/);
});
