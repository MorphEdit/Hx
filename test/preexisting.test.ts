// A red test is the change's until the same test is shown failing at the base commit (#250): impl.md asks for that
// proof before a failure is called pre-existing, audit.md re-runs a claimed one at the base and fails a PR it passes there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8').replace(/\s+/g, ' ');

for (const name of ['impl', 'audit']) {
  test(`${name}.md: a red test is the change's until the same test fails at the base commit, with the runner's output`, () => {
    const p = prompt(name);
    assert.match(p, /A red test is (your|the) change's until the same test is shown failing at the base commit/);
    assert.match(p, /worktree of `origin\/\{\{BASE\}\}`/);
    assert.match(p, /runner's (own )?output/);
    for (const claim of ['pre-existing', 'flaky', 'unrelated']) assert.match(p, new RegExp(`"${claim}"`, 'i'), claim);
  });
}

test('impl.md: no leaving a pre-existing failure without its proof; a test red on the branch and green at the base is yours', () => {
  const p = prompt('impl');
  assert.doesNotMatch(p, /are not yours: leave them, note them/);
  assert.match(p, /"environment" all need that proof/);
  assert.match(p, /A summary in prose is not proof/);
  assert.match(p, /fails on your branch and passes at the base is yours to fix/);
  assert.match(p, /A proven pre-existing failure is not yours to fix: note it with its proof and go on/);});

test('audit.md: a claimed pre-existing failure is re-run at the base, and a test green there and red on the branch is a FAIL', () => {
  const p = prompt('audit');
  assert.match(p, /"already broken".* are claims to disprove: re-run that test yourself at the base/);
  assert.match(p, /It passes at the base and fails on the branch: VERDICT: FAIL/);
});
