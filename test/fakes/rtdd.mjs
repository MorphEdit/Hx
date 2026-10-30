// Fake `rtdd` for tests. HX_FAKE_RTDD_LOG: every call appends its arguments (JSON) as one line.
// `--version` prints a version (HX_FAKE_RTDD_VERSION_FAIL=1: fails); `init` writes .rtdd/config.yaml and
// .rtdd/.gitignore in its cwd (HX_FAKE_RTDD_INIT_FAIL=1: fails).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
if (process.env.HX_FAKE_RTDD_LOG) appendFileSync(process.env.HX_FAKE_RTDD_LOG, JSON.stringify(a) + '\n');
if (a[0] === '--version') {
  if (process.env.HX_FAKE_RTDD_VERSION_FAIL) { process.stderr.write('rtdd: broken install\n'); process.exit(1); }
  process.stdout.write('rtdd 0.0.0-fake\n');
} else if (a[0] === 'init') {
  if (process.env.HX_FAKE_RTDD_INIT_FAIL) { process.stderr.write('rtdd init: failed\n'); process.exit(1); }
  mkdirSync('.rtdd', { recursive: true });
  writeFileSync('.rtdd/config.yaml', 'version: 1\n');
  writeFileSync('.rtdd/.gitignore', '*.db\n');
} else {
  process.stderr.write(`rtdd (fake): unknown command ${a.join(' ')}\n`);
  process.exit(2);
}
