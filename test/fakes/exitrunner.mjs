// A stand-in for `hx run --watch` with the exit recorder of src/runstate.ts (#472): argv[2] is its state dir, argv[3]
// what ends it. It logs `hx pool up` to <state dir>/run.log, writes <state dir>/ready (its pid), then:
//   throw          an uncaught exception
//   reject         an unhandled rejection
//   signal:<SIG>   the signal's event, as Node delivers a real one (a real one cannot be sent to a process on Windows)
//   sigint         the SIGINT event, a copy of exit.json to exit-early.json, then a clean end with code 0
//   end:<code>     the run ends by itself with that code
//   exit:<code>    process.exit somewhere, with no end
//   wait           nothing: the test sends a real signal
//   console        waits for <state dir>/go, logs two lines and a stderr line (its console may be gone), ends with code 0
// A crash or a signal also writes <state dir>/stopped (the onStop hook: hx run kills its sessions there).
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log, runLogFile, setRunLog } from '../../src/pool.ts';
import { recordExits } from '../../src/runstate.ts';

const stateDir = process.argv[2], [mode, arg] = (process.argv[3] ?? 'wait').split(':');
const at = (f) => path.join(stateDir, f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setRunLog(runLogFile(stateDir));
const rec = recordExits({ stateDir, log: (l) => log(l), onStop: () => writeFileSync(at('stopped'), String(process.pid)) });
log('hx pool up');
writeFileSync(at('ready'), String(process.pid));
const keep = setInterval(() => {}, 1000); // a runner's loop: nothing here ends the process by itself

if (mode === 'throw') setTimeout(() => { throw new Error('boom in\nthe loop'); }, 0);
else if (mode === 'reject') Promise.reject(new Error('a promise nobody awaited'));
else if (mode === 'signal') setTimeout(() => process.emit(arg), 0);
else if (mode === 'sigint') {
  process.on('SIGINT', () => {}); // hx run's own Ctrl+C handler: it checkpoints, the run then ends by itself
  process.emit('SIGINT');
  copyFileSync(at('exit.json'), at('exit-early.json'));
  rec.end(0);
  clearInterval(keep);
} else if (mode === 'end') { rec.end(Number(arg)); process.exitCode = Number(arg); clearInterval(keep); }
else if (mode === 'exit') setTimeout(() => process.exit(Number(arg)), 0);
else if (mode === 'console') {
  while (!existsSync(at('go'))) await sleep(50);
  log('board empty — watching for new issues');
  await sleep(200);
  console.error('(node) Warning: something');
  log('still here');
  await sleep(200);
  rec.end(0);
  clearInterval(keep);
}
