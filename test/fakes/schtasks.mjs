// Fake schtasks.exe (HX_SCHTASKS_BIN): appends {args, xml} to FAKE_SCHTASKS_LOG (xml: the /XML file's text, read before
// hx deletes it) and keeps the registered task names in FAKE_SCHTASKS_LOG + '.tasks'. /Query of a task that is not
// registered exits 1, like the real one.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const log = process.env.FAKE_SCHTASKS_LOG;
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const xmlFile = opt('/XML');
const xml = xmlFile ? readFileSync(xmlFile, 'utf16le').replace(/^\ufeff/, '') : null;
appendFileSync(log, JSON.stringify({ args: a, xml }) + '\n');
const tasksFile = log + '.tasks';
const tasks = existsSync(tasksFile) ? JSON.parse(readFileSync(tasksFile, 'utf8')) : [];
const name = opt('/TN');
const save = (t) => writeFileSync(tasksFile, JSON.stringify(t));
if (a[0] === '/Create') { save([...tasks.filter((t) => t !== name), name]); console.log(`SUCCESS: The scheduled task "${name}" has successfully been created.`); }
else if (a[0] === '/Delete') {
  if (!tasks.includes(name)) { console.error('ERROR: The system cannot find the file specified.'); process.exit(1); }
  save(tasks.filter((t) => t !== name));
  console.log(`SUCCESS: The scheduled task "${name}" was successfully deleted.`);
} else if (a[0] === '/Query') {
  if (!tasks.includes(name)) { console.error('ERROR: The system cannot find the file specified.'); process.exit(1); }
  console.log(`\r\nFolder: \\hx\r\nTaskName:                             \\${name}\r\nStatus:                               Ready\r\nLast Run Time:                        11/5/2026 9:00:00 AM\r\nLast Result:                          0\r\n`);
}
