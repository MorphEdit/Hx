// The new tests are proven to fail without the change (#251): the auditor runs them on the code with the change
// reverted, sees them red, restores the branch and sees them green; the implementer does the same once before shipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8').replace(/\s+/g, ' ');

test('audit.md: the new tests run on the code with the change reverted, the branch\'s tests kept', () => {
  const p = prompt('audit');
  assert.match(p, /by running them on the code with the change reverted/);
  assert.match(p, /at least one new or changed test per acceptance criterion that has a test/);
  assert.match(p, /restore the non-test files to `origin\/\{\{BASE\}\}` and keep the branch's tests/);
  assert.match(p, /`git checkout origin\/\{\{BASE\}\} -- <changed source files>`/);
  assert.doesNotMatch(p, /would they fail if it were wrong\?/);
});

test('audit.md: the test must fail on the reverted code, then the branch is restored and it passes', () => {
  const p = prompt('audit');
  assert.match(p, /2\. run that test and see it fail; 3\. restore the branch \(`git checkout HEAD -- \.`\) and see it pass/);
  assert.match(p, /The audit leaves the checkout as it found it/);
});

test('audit.md: a criterion with no test failing on the reverted code is a FAIL, unless the issue says it is not testable', () => {
  const p = prompt('audit');
  assert.match(p, /A criterion with no test that fails on the reverted code is "a test that does not test": VERDICT: FAIL, unless the issue says that criterion is not testable/);
});

test('audit.md: on a PASS the evidence line names the test with its red result reverted and green on the branch', () => {
  const p = prompt('audit');
  assert.match(p, /For a criterion with a test, its evidence line names the test and shows both results of step 7: red on the reverted code, green on the branch/);
  assert.match(p, /- <criterion> — <test name> — reverted: <command> → <red result> — branch: <command> → <green result>/);
});

test('impl.md: before shipping, the implementer sees a new test fail without the change and names it', () => {
  const p = prompt('impl');
  assert.match(p, /Before shipping, check once that your new tests fail without your change/);
  assert.match(p, /restore the non-test files to `origin\/\{\{BASE\}\}`/);
  assert.match(p, /run the new tests and see one fail, then restore your branch \(`git checkout HEAD -- \.`\) and see them pass/);
  assert.match(p, /commit your work first (`git add -A` then `git commit`: the restore below would discard uncommitted work)/);
  assert.match(p, /Your final message names the test you saw fail/);
  // before step 4, the ship
  assert.ok(p.indexOf('Before shipping, check once') < p.indexOf('4. Ship in one call'));
});
