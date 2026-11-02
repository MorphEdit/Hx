// Fake `npm` for the installer tests: records each call's arguments as one line in FAKE_NPM_LOG and installs
// nothing; FAKE_NPM_EXIT makes it fail with that code.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, process.argv.slice(2).join(' ') + '\n');
if (process.env.FAKE_NPM_EXIT) {
  process.stderr.write('npm ERR! code EACCES\nnpm ERR! permission denied\n');
  process.exit(Number(process.env.FAKE_NPM_EXIT));
}
