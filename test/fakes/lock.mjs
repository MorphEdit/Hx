import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Windows: reading the board while another process renames over it (or renaming while one reads it)
// fails with EPERM / EBUSY / EACCES for a moment — retry instead of crashing the fake.
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i > 400 || !['EPERM', 'EBUSY', 'EACCES', 'ENOENT'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
export const loadJson = (file) => JSON.parse(retry(() => readFileSync(file, 'utf8')));
export function saveJson(file, data) {
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  retry(() => renameSync(file + '.tmp', file));
}
