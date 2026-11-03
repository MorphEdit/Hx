// #223: workers run only the affected tests while working; the full suite runs once, in ship.mjs after the
// rebase (and in the gate on the default branch). The impl, continue and audit prompts, the resume note and
// the rtdd skill note say so; ship.mjs still runs the full --test command.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
const prompt = (name: string) => read(`prompts/${name}.md`);
const { RESUME_TESTS_NOTE } = await import('../src/pool.ts');

test('impl prompt: affected tests only while working, never the full command before ship, the full suite only after exit 4', E2E, () => {
  const p = prompt('impl');
  assert.match(p, /While working, run only the affected tests/);
  assert.match(p, /the test files for the code you changed/);
  assert.match(p, /the tests `rtdd which` names when the rtdd skill is loaded/);
  assert.match(p, /any test file the issue names/);
  assert.match(p, /Never run the full test command before shipping: ship\.mjs runs it after the rebase/);
  assert.match(p, /Run the full suite only after a ship\.mjs exit 4, to check that failure, and then only once before shipping again/);
  assert.doesNotMatch(p, /Run the tests until green \(/, 'the old "run the tests" step is gone');
  // kept
  assert.match(p, /at least one test must fail without your change/);
  assert.match(p, /Never delete, skip or weaken an existing test/);
  assert.match(p, /--test "<test command>"/, 'ship still gets the full test command');
});

test('continue prompt: the same test rule', E2E, () => {
  const p = prompt('continue');
  assert.match(p, /run only the affected tests/);
  assert.match(p, /Never run the full test command before shipping: ship\.mjs runs it after the rebase/);
  assert.match(p, /Run the full suite only after a ship\.mjs exit 4, and then only once before shipping again/);
  assert.ok(p.indexOf('affected tests') < p.indexOf('<promise>'), 'the rule comes before the promise line');
});

test('audit prompt: the auditor runs only the affected tests, not the full suite', E2E, () => {
  const p = prompt('audit');
  assert.match(p, /Run only the affected tests: the test files for the changed code/);
  assert.match(p, /the tests `rtdd which` names when the rtdd skill is loaded, and any test file the issue names/);
  assert.match(p, /Do not run the full test command: the gate and ship\.mjs run the full suite/);
  assert.doesNotMatch(p, /Run the project's tests\./);
  assert.match(p, /never a PASS you did not see/, 'a killed test run is still a FAIL');
});

test('resume note and rtdd skill note: no full suite before ship', E2E, () => {
  assert.match(RESUME_TESTS_NOTE, /^Run only the affected tests while you work; never the full test command before shipping \(ship\.mjs runs it after the rebase\)/);
  assert.match(RESUME_TESTS_NOTE, /the full suite only after a ship\.mjs exit 4, once before shipping again/);
  const pool = read('src/pool.ts');
  assert.equal(pool.match(/\$\{RESUME_TESTS_NOTE\}/g)?.length, 3, 'the handoff resume note, the audit-failed and the merge-failed feedback');
  const skill = prompt('skills/rtdd');
  assert.doesNotMatch(skill, /Finish with the full test suite once/);
  assert.match(skill, /Skip Round 3: do not run the full test suite yourself\. ship\.mjs runs it once after the rebase/);
});

test('ship.mjs still runs the full --test command after the rebase', E2E, () => {
  const s = read('scripts/ship.mjs');
  assert.match(s, /spawn\(testCmd, \[\], \{ shell: true/);
  assert.ok(s.indexOf('rebase') < s.indexOf('spawn(testCmd'), 'the tests run after the rebase');
  assert.match(s, /tests failed after rebasing on origin/);
});

test('design.md records the decision', E2E, () => {
  const d = read('docs/design.md');
  assert.match(d, /## Test runs \(#223\) The full suite runs once per ship/);
  assert.match(d, /the gate runs it again on the default branch after each merge/);
});
