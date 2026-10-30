#!/usr/bin/env node
// issue.mjs — print an issue for a worker's prompt with the comments of untrusted accounts removed:
// anyone can comment on a public issue, and a worker runs with bypassPermissions, so only comments
// by the logins in HX_TRUSTED reach it.
//
//   HX_TRUSTED=alice,bob node issue.mjs --repo owner/name --issue 12
//
// HX_TRUSTED: comma-separated logins, matched case-insensitively. Missing or empty → exit 2: there is
// no fallback that shows everything.
// Exit codes: 0 printed · 2 bad arguments or no HX_TRUSTED · 1 gh failed (its error on stderr)
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const repo = opt('repo'), issue = opt('issue');
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !issue || !/^\d+$/.test(issue)) {
  console.error('usage: issue.mjs --repo owner/name --issue N   (env HX_TRUSTED=login1,login2)');
  process.exit(2);
}
const trusted = new Set((process.env.HX_TRUSTED ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
if (trusted.size === 0) {
  console.error('issue: HX_TRUSTED is not set: refusing to print comments from unknown accounts');
  process.exit(2);
}

// gh can be swapped (HX_GH_BIN, as in hx itself); a .js/.mjs one runs under this node
const GH = process.env.HX_GH_BIN || 'gh';
const ghArgs = ['issue', 'view', issue, '-R', repo, '--json', 'number,title,author,state,labels,body,comments'];
const r = /\.m?js$/i.test(GH)
  ? spawnSync(process.execPath, [GH, ...ghArgs], { encoding: 'utf8' })
  : spawnSync(GH, ghArgs, { encoding: 'utf8' });
if (r.error || r.status !== 0) {
  console.error(`issue: gh issue view failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  process.exit(1);
}
let data;
try { data = JSON.parse(r.stdout); } catch { console.error('issue: gh printed no JSON'); process.exit(1); }

const login = (a) => (typeof a?.login === 'string' ? a.login : '');
const isTrusted = (c) => login(c.author) !== '' && trusted.has(login(c.author).toLowerCase());
const comments = data.comments ?? [];
const shown = comments.filter(isTrusted);
const hidden = comments.length - shown.length;

const out = [
  `#${data.number} ${data.title ?? ''}`,
  `author: ${login(data.author) || '(unknown)'} · state: ${data.state ?? ''} · labels: ${(data.labels ?? []).map((l) => l.name).join(', ') || '(none)'}`,
  '',
  data.body ?? '',
];
for (const c of shown) out.push('', `--- comment by ${login(c.author)} on ${c.createdAt ?? ''}`, '', c.body ?? '');
if (hidden > 0) out.push('', `(${hidden} ${hidden === 1 ? 'comment' : 'comments'} from untrusted accounts hidden)`);
process.stdout.write(out.join('\n') + '\n');
