// hx service: starts `hx supervise` at logon. Windows: one Task Scheduler task per repo for the current user (a logon
// trigger, no stored password, no elevation), registered from XML with schtasks.exe. macOS / Linux: prints the launchd
// or systemd --user unit and the commands to install it, and changes nothing. The task and units are built by pure
// functions; the tests run a fake schtasks (HX_SCHTASKS_BIN).
// autoStart (config): hx run keeps that task in step with the setting (syncAutoStart); .hx/autostart.json keeps the
// last check for the dashboard.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';
import { pidAlive, readLive } from './runstate.ts';
import { readSupervise } from './supervise.ts';

export interface ServiceSpec {
  name: string; // the repo's name, e.g. "Hx"
  root: string; // the repo: the working directory of hx supervise
  node: string; // the node executable
  entry: string; // bin/hx.mjs
  args: string[]; // after `supervise`, e.g. ['--workers', '2']
  user: string; // DOMAIN\user on Windows
}

/** `<repo name>-<8 hex chars of the repo path>`: two repos, or two clones of one, get two names. */
export function serviceId(repo: string, root: string): string {
  const name = (repo.split('/').pop() || path.basename(root)).replace(/[^A-Za-z0-9._-]/g, '_');
  const norm = path.resolve(root).replace(/[\\/]+$/, '');
  const hash = createHash('sha1').update(process.platform === 'win32' ? norm.toLowerCase() : norm).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/** The Task Scheduler task name: `hx\<repo name>-<hash>` (a task in the \hx\ folder). */
export const taskName = (id: string) => `hx\\${id}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command line of the action: `"<entry>" supervise [args]`, run by node in the repo. */
export const superviseArgs = (s: ServiceSpec) => [s.entry, 'supervise', ...s.args].map(quote).join(' ');

/** The task: at logon of the current user only, run as that user (interactive token: no password), least privilege. */
export function taskXml(s: ServiceSpec): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>hx supervise in ${xml(s.root)}</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(s.user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${xml(s.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(s.node)}</Command>
      <Arguments>${xml(superviseArgs(s))}</Arguments>
      <WorkingDirectory>${xml(s.root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks.exe arguments: /F replaces a task of the same name; the task's user, trigger and rights come from the XML. */
export const schtasksCreate = (name: string, xmlFile: string) => ['/Create', '/TN', name, '/XML', xmlFile, '/F'];
export const schtasksDelete = (name: string) => ['/Delete', '/TN', name, '/F'];
export const schtasksQuery = (name: string) => ['/Query', '/TN', name, '/V', '/FO', 'LIST'];
/** The registered task's XML: the same in every Windows language, unlike the /V LIST keys. */
export const schtasksQueryXml = (name: string) => ['/Query', '/TN', name, '/XML'];

/** The <WorkingDirectory> of a task's XML (the repo the task runs hx supervise in), undefined when it has none. */
export function taskWorkingDir(text: string): string | undefined {
  const m = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(text.replace(/\0/g, ''));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : undefined;
}

/** Two Windows paths name one directory: case and a trailing separator aside. */
export const samePath = (a: string, b: string) => {
  const norm = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/** "Last Result" and "Last Run Time" from `schtasks /Query /V /FO LIST`. */
export function parseQuery(out: string): { lastResult?: string; lastRun?: string; status?: string } {
  const get = (k: string) => out.split(/\r?\n/).find((l) => l.startsWith(k + ':'))?.slice(k.length + 1).trim();
  return { lastResult: get('Last Result'), lastRun: get('Last Run Time'), status: get('Status') };
}

/** The systemd --user unit (Linux): started when the user's session starts. */
export function systemdUnit(s: ServiceSpec): string {
  return `[Unit]
Description=hx supervise in ${s.root}

[Service]
WorkingDirectory=${s.root}
ExecStart=${[s.node, s.entry, 'supervise', ...s.args].map(quote).join(' ')}
Restart=no

[Install]
WantedBy=default.target
`;
}

/** The launchd agent (macOS): loaded at login. */
export function launchdPlist(s: ServiceSpec, label: string): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label)}
  <key>ProgramArguments</key>
  <array>${[s.node, s.entry, 'supervise', ...s.args].map(str).join('')}</array>
  <key>WorkingDirectory</key>${str(s.root)}
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

/** What `hx service <sub>` prints on macOS and Linux: the unit and the commands; nothing is changed. */
export function unixService(sub: string, platform: string, id: string, s: ServiceSpec): string {
  if (platform === 'darwin') {
    const label = `com.hx.${id}`, file = `~/Library/LaunchAgents/${label}.plist`;
    if (sub === 'uninstall') return `hx changes nothing here. To remove the agent:\n  launchctl unload -w ${file}\n  rm ${file}\n`;
    if (sub === 'status') return `hx changes nothing here. To check the agent:\n  launchctl list ${label}\n`;
    return `hx changes nothing here. Save this as ${file}:\n\n${launchdPlist(s, label)}\nthen run:\n  launchctl load -w ${file}\n`;
  }
  const unit = `hx-${id}.service`, file = `~/.config/systemd/user/${unit}`;
  if (sub === 'uninstall') return `hx changes nothing here. To remove the unit:\n  systemctl --user disable --now ${unit}\n  rm ${file}\n  systemctl --user daemon-reload\n`;
  if (sub === 'status') return `hx changes nothing here. To check the unit:\n  systemctl --user status ${unit}\n`;
  return `hx changes nothing here. Save this as ${file}:\n\n${systemdUnit(s)}\nthen run:\n  mkdir -p ~/.config/systemd/user\n  systemctl --user daemon-reload\n  systemctl --user enable --now ${unit}\n`;
}

export interface ServiceOptions {
  sub: string;
  repo: string;
  root: string;
  stateDir: string;
  args: string[];
  entry: string;
  platform?: string; // default process.platform
  print?: (s: string) => void;
}

const schtasksBin = () => process.env.HX_SCHTASKS_BIN || 'schtasks.exe';

/** The current user as the task's principal: DOMAIN\user on Windows. */
const currentUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username);

const specFor = (id: string, root: string, entry: string, args: string[]): ServiceSpec =>
  ({ name: id, root: path.resolve(root), node: process.execPath, entry, args, user: currentUser() });

/** Register (or replace) the task from taskXml; null, or what schtasks said when it refused. */
async function createTask(name: string, spec: ServiceSpec): Promise<string | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-task-'));
  const file = path.join(dir, 'task.xml');
  try {
    writeFileSync(file, '﻿' + taskXml(spec), 'utf16le');
    const r = await run(schtasksBin(), schtasksCreate(name, file));
    return r.code === 0 ? null : (r.stderr || r.stdout).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function deleteTask(name: string): Promise<string | null> {
  const r = await run(schtasksBin(), schtasksDelete(name));
  return r.code === 0 ? null : (r.stderr || r.stdout).trim();
}

/** The task as hx finds it: registered for this repo, missing, or registered for another path. */
export type TaskState = 'registered' | 'missing' | 'elsewhere';

/** One /Query of the task's XML: a task whose WorkingDirectory is not `root` is `elsewhere`. */
export async function taskState(name: string, root: string): Promise<TaskState> {
  const r = await run(schtasksBin(), schtasksQueryXml(name));
  if (r.code !== 0) return 'missing';
  const wd = taskWorkingDir(r.stdout);
  return wd !== undefined && samePath(wd, root) ? 'registered' : 'elsewhere';
}

/** `.hx/autostart.json`: hx run's last autoStart check, and the unit id it printed off Windows (printed once). */
export interface AutoStartRecord { at: string; enabled: boolean; task: TaskState | 'unit'; name: string; line?: string; printed?: string }

const autoStartFile = (stateDir: string) => path.join(stateDir, 'autostart.json');

export function readAutoStart(stateDir: string): AutoStartRecord | null {
  const f = autoStartFile(stateDir);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function writeAutoStart(stateDir: string, rec: AutoStartRecord): void {
  const f = autoStartFile(stateDir);
  try { writeFileSync(f + '.tmp', JSON.stringify(rec, null, 2)); renameSync(f + '.tmp', f); } catch {}
}

/** What hx doctor and the dashboard say of the setting and its task. */
export function autoStartText(enabled: boolean, task: TaskState | 'unit' | undefined): string {
  if (!enabled) return 'off';
  if (task === 'registered') return 'on (task registered)';
  if (task === 'missing') return 'on (task missing — hx run will register it)';
  if (task === 'elsewhere') return 'on (task points at another path — hx run will register it)';
  if (task === 'unit') return 'on (no task here: hx service install prints the unit to install)';
  return 'on (not checked yet)';
}

export interface AutoStartOptions {
  enabled: boolean; // config.autoStart
  repo: string;
  root: string;
  stateDir: string;
  entry: string; // bin/hx.mjs
  platform?: string; // default process.platform
  log?: (line: string) => void; // `autoStart: registered hx\<id>` / `removed …`: only when it changed something
  print?: (s: string) => void; // the launchd / systemd unit, off Windows
}

/** hx run's start. Windows: autoStart on and this repo's task missing or pointing at another path → register it as
 *  hx service install does; off and the task exists → remove it. Only this repo's task name is ever queried or changed.
 *  Off Windows: on prints the unit once per repo (as hx service install does there) and changes nothing. */
export async function syncAutoStart(o: AutoStartOptions): Promise<AutoStartRecord> {
  const platform = o.platform ?? process.platform;
  const log = o.log ?? ((l: string) => console.log(l));
  const id = serviceId(o.repo, o.root);
  const prev = readAutoStart(o.stateDir);
  const at = new Date().toISOString();
  if (platform !== 'win32') {
    const rec: AutoStartRecord = { at, enabled: o.enabled, task: 'unit', name: id, ...(prev?.printed ? { printed: prev.printed } : {}) };
    if (o.enabled && prev?.printed !== id) {
      (o.print ?? ((s: string) => console.log(s)))(unixService('install', platform, id, specFor(id, o.root, o.entry, [])));
      rec.printed = id;
    }
    writeAutoStart(o.stateDir, rec);
    return rec;
  }
  const name = taskName(id);
  const rec: AutoStartRecord = { at, enabled: o.enabled, task: await taskState(name, o.root), name };
  if (o.enabled && rec.task !== 'registered') {
    const err = await createTask(name, specFor(id, o.root, o.entry, []));
    rec.line = err === null ? `autoStart: registered ${name}` : `autoStart: could not register ${name}: ${err}`;
    if (err === null) rec.task = 'registered';
    log(rec.line);
  } else if (!o.enabled && rec.task !== 'missing') {
    const err = await deleteTask(name);
    rec.line = err === null ? `autoStart: removed ${name}` : `autoStart: could not remove ${name}: ${err}`;
    if (err === null) rec.task = 'missing';
    log(rec.line);
  }
  writeAutoStart(o.stateDir, rec);
  return rec;
}

export async function service(o: ServiceOptions): Promise<number> {
  const print = o.print ?? ((s: string) => console.log(s));
  const platform = o.platform ?? process.platform;
  const id = serviceId(o.repo, o.root);
  const spec = specFor(id, o.root, o.entry, o.args);
  if (!['install', 'uninstall', 'status'].includes(o.sub)) { print('usage: hx service install [--workers N] | uninstall | status'); return 2; }
  if (platform !== 'win32') { print(unixService(o.sub, platform, id, spec)); return 0; }
  const name = taskName(id);
  if (o.sub === 'install') {
    const err = await createTask(name, spec);
    if (err !== null) { print(`could not register ${name}: ${err}`); return 1; }
    print(`registered ${name}: at your logon, ${spec.node} ${superviseArgs(spec)} in ${spec.root}`);
    return 0;
  }
  if (o.sub === 'uninstall') {
    const err = await deleteTask(name);
    if (err !== null) { print(`no task ${name} removed: ${err}`); return 1; }
    print(`removed ${name}`);
    return 0;
  }
  const r = await run(schtasksBin(), schtasksQuery(name));
  if (r.code !== 0) print(`task       ${name}: not installed (hx service install)`);
  else {
    const q = parseQuery(r.stdout);
    print(`task       ${name}: installed${q.status ? ` · ${q.status}` : ''} · last run ${q.lastRun ?? '?'} · last result ${q.lastResult ?? '?'}`);
  }
  const sv = readSupervise(o.stateDir);
  print(`supervisor ${sv.pid && pidAlive(sv.pid) ? `running · pid ${sv.pid}` : 'not running'}${sv.last ? ` — ${sv.last.line}` : ''}`);
  const live = readLive(o.stateDir);
  print(`runner     ${live && pidAlive(live.pid) ? `running · pid ${live.pid}` : 'not running'}`);
  return 0;
}
