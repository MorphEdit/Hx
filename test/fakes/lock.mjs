import { closeSync, openSync, unlinkSync } from 'node:fs';
// Parallel fake processes edit one JSON board: serialise read-modify-write with a lock file.
export function locked(file, fn) {
  let fd;
  for (let i = 0; ; i++) {
    try { fd = openSync(file + '.lock', 'wx'); break; } catch {
      if (i > 2000) throw new Error('fake board lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { closeSync(fd); unlinkSync(file + '.lock'); }
}
