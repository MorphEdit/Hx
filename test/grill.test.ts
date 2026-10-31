import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, workerArgs } from '../src/config.ts';
import { grillArgs, grillPaths, grillPrompt, ideaFrom, INLINE_PROMPT_MAX, issuePaths, sessionPrompt } from '../src/grill.ts';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'hx-grill-'));

test('grillArgs: model, effort, prompt last; no worker flags', () => {
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: 'x' };
  const args = grillArgs(config, 'PROMPT');
  assert.deepEqual(args, ['--model', 'claude-opus-5-5', '--effort', 'medium', 'PROMPT']);
  const forbidden = ['-p', '--print', 'bypassPermissions', '--permission-mode', '--output-format', 'stream-json',
    '--verbose', ...workerArgs(config).filter(a => a.startsWith('--'))];
  assert.ok(forbidden.includes('--strict-mcp-config') && forbidden.includes('--setting-sources'));
  for (const f of forbidden) assert.ok(!args.includes(f), `${f} must not be passed`);
  assert.deepEqual(grillArgs({ ...config, effort: '' }, 'P'), ['--model', 'claude-opus-5-5', 'P']);
});

test('grillPaths: local-time zero-padded stamp under <stateDir>/prds', () => {
  const p = grillPaths(path.join('r', '.hx'), new Date(2026, 0, 5, 7, 3, 9));
  assert.equal(p.prd, path.join('r', '.hx', 'prds', '20260105-070309-grill.md'));
  assert.equal(p.promptFile, path.join('r', '.hx', 'prds', '20260105-070309-grill.prompt.md'));
  assert.match(path.basename(grillPaths('s').prd), /^\d{8}-\d{6}-grill\.md$/);
});

test('grillPrompt: short idea inline with repo, base, idea and output', () => {
  const dir = tmp();
  const promptFile = path.join(dir, 'prds', 'x.prompt.md');
  const out = grillPrompt({ repo: 'me/app', base: 'dev', idea: 'add dark mode', output: 'C:/o/prd.md' }, promptFile);
  assert.match(out.split('\n')[0], /Role: grill/);
  for (const s of ['me/app', '`dev`', 'add dark mode', 'C:/o/prd.md']) assert.ok(out.includes(s), s);
  assert.ok(!/\{\{\w+\}\}/.test(out), 'no placeholder left');
  assert.ok(out.length <= INLINE_PROMPT_MAX);
  assert.ok(!existsSync(promptFile));
});

test('grillPrompt: long idea goes through the prompt file', () => {
  const dir = tmp();
  const promptFile = path.join(dir, 'prds', 'x.prompt.md');
  const idea = 'long idea. '.repeat(700);
  assert.ok(idea.length > 6000);
  const out = grillPrompt({ repo: 'me/app', base: 'main', idea, output: 'o.md' }, promptFile);
  assert.match(out.split('\n')[0], /Role: grill/);
  assert.ok(out.includes(promptFile) && out.length < 500, out);
  const full = readFileSync(promptFile, 'utf8');
  assert.ok(full.includes(idea) && full.includes('me/app') && full.includes('o.md'));
  assert.match(full, /^Role: grill/);
});

test('ideaFrom: file path, plain text, none', () => {
  const f = path.join(tmp(), 'idea.md');
  writeFileSync(f, 'idea from a file\n');
  assert.equal(ideaFrom(f), 'idea from a file\n');
  assert.equal(ideaFrom('just some text'), 'just some text');
  const missing = path.join(tmp(), 'missing.md');
  assert.equal(ideaFrom(missing), missing); // not an existing file → the text as given
  const dir = tmp();
  assert.equal(ideaFrom(dir), dir); // a directory is not a file
  assert.equal(ideaFrom(), '');
});

test('prompts/grill.md: interview rules, things to settle, output placeholder, files nothing itself', () => {
  const t = readFileSync(new URL('../prompts/grill.md', import.meta.url), 'utf8');
  assert.match(t, /^Role: grill/);
  assert.match(t, /one question at a time/i);
  assert.match(t, /recommended\s+answer/i);
  for (const s of ['problem and goals', 'non-goals', 'user-facing behaviour', 'acceptance criteria a test can check',
    'edge cases and error handling', 'constraints from the existing code']) assert.ok(t.includes(s), s);
  for (const v of ['{{REPO}}', '{{BASE}}', '{{IDEA}}', '{{OUTPUT}}']) assert.ok(t.includes(v), v);
  for (const s of ['# <title>', 'Goals', 'Non-goals', 'Behaviour', 'Acceptance criteria', 'Edge cases', 'Notes for implementers'])
    assert.ok(t.includes(s), s);
  assert.match(t, /never create issues/i);
  assert.match(t, /\/exit/);
  assert.match(t, /if the idea above is empty/i);
  assert.match(t, /challenge vague answers/i);
});

test('issuePaths: local-time stamp under <stateDir>/issues', () => {
  const p = issuePaths(path.join('r', '.hx'), new Date(2026, 0, 5, 7, 3, 9));
  assert.equal(p.out, path.join('r', '.hx', 'issues', '20260105-070309-issue.md'));
  assert.equal(p.promptFile, path.join('r', '.hx', 'issues', '20260105-070309-issue.prompt.md'));
});

test('sessionPrompt issue: issue.md rendered with repo, base, idea, output and the issue script; long → prompt file', () => {
  const dir = tmp();
  const promptFile = path.join(dir, 'issues', 'x.prompt.md');
  const out = sessionPrompt('issue', { repo: 'me/app', base: 'dev', idea: 'fix it', output: 'C:/o/issue.md' }, promptFile);
  assert.match(out, /^Role: issue/);
  for (const s of ['me/app', '`dev`', 'fix it', 'C:/o/issue.md', 'scripts/issue.mjs']) assert.ok(out.includes(s), s);
  assert.ok(!/\{\{\w+\}\}/.test(out), 'no placeholder left');
  assert.ok(!existsSync(promptFile));
  const long = sessionPrompt('issue', { repo: 'me/app', base: 'dev', idea: 'x. '.repeat(3000), output: 'o.md' }, promptFile);
  assert.match(long, /^Role: issue\nRead .+ first/);
  assert.match(readFileSync(promptFile, 'utf8'), /^Role: issue/);
});

test('prompts/issue.md: placeholders, shape, one question at a time, issue script only, files nothing itself', () => {
  const t = readFileSync(new URL('../prompts/issue.md', import.meta.url), 'utf8');
  assert.match(t, /^Role: issue/);
  for (const v of ['{{REPO}}', '{{BASE}}', '{{IDEA}}', '{{OUTPUT}}', '{{ISSUE_SCRIPT}}']) assert.ok(t.includes(v), v);
  assert.ok(!t.includes('gh issue view') && !t.includes('--comments'), 'reads issues only through the script');
  assert.match(t, /never file, comment, commit or push/i);
  assert.match(t, /one question at a time/i);
  assert.match(t, /recommended\s+answer/i);
  assert.match(t, /acceptance criteria a test can check/i);
  assert.match(t, /bigger than one issue[\s\S]*hx grill/);
  assert.match(t, /never edit any file other\s+than `\{\{OUTPUT\}\}`/);
  for (const s of ['# <title>', '## What to do', '## Acceptance criteria', '## Edge cases', '## Blocked by']) assert.ok(t.includes(s), s);
});
