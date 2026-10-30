// test/isolate.ts: what a live `hx run` or the user's git setup leaves in the environment never reaches the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('isolate: HX_* / FAKE_* / GIT_DIR from the caller are dropped, git gets an empty global config', () => {
  const code = `await import(${JSON.stringify(pathToFileURL(path.join(here, 'isolate.ts')).href)});
    console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HX_|FAKE_|GIT_)/.test(k)))));`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: 'real-gh', HX_SHIP_TEST_TIMEOUT_MS: '1', FAKE_CLAUDE_DELAY_MS: '99999', GIT_DIR: 'C:/elsewhere/.git' } });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(env).filter((k) => /^(HX_|FAKE_)/.test(k)), []);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(env.GIT_CONFIG_GLOBAL);
});
