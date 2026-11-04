// hx service: starts `hx supervise` at logon. Windows: one Task Scheduler task per repo for the current user (a logon
// trigger, no stored password, no elevation), registered from XML with schtasks.exe. macOS / Linux: prints the launchd
// or systemd --user unit and the commands to install it, and changes nothing. The task and units are built by pure
// functions; the tests run a fake schtasks (HX_SCHTASKS_BIN).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

export async function service(o: ServiceOptions): Promise<number> {
  const print = o.print ?? ((s: string) => console.log(s));
  const platform = o.platform ?? process.platform;
  const id = serviceId(o.repo, o.root);
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  const spec: ServiceSpec = { name: id, root: path.resolve(o.root), node: process.execPath, entry: o.entry, args: o.args, user };
  if (!['install', 'uninstall', 'status'].includes(o.sub)) { print('usage: hx service install [--workers N] | uninstall | status'); return 2; }
  if (platform !== 'win32') { print(unixService(o.sub, platform, id, spec)); return 0; }
  const name = taskName(id);
  if (o.sub === 'install') {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-task-'));
    const file = path.join(dir, 'task.xml');
    try {
      writeFileSync(file, '﻿' + taskXml(spec), 'utf16le');
      const r = await run(schtasksBin(), schtasksCreate(name, file));
      if (r.code !== 0) { print(`could not register ${name}: ${(r.stderr || r.stdout).trim()}`); return 1; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    print(`registered ${name}: at your logon, ${spec.node} ${superviseArgs(spec)} in ${spec.root}`);
    return 0;
  }
  if (o.sub === 'uninstall') {
    const r = await run(schtasksBin(), schtasksDelete(name));
    if (r.code !== 0) { print(`no task ${name} removed: ${(r.stderr || r.stdout).trim()}`); return 1; }
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
