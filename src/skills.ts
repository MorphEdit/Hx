// Per-role skills: a role's prompt gets the SKILL.md bodies config.roleSkills names for it, appended
// after the prompt is rendered. A skill is resolved once per run:
//   1. its availability check, if it has one (a dropped skill is never read from disk)
//   2. the first SKILL.md of <repo>/.claude/skills/x, <home>/.claude/skills/x, <repo>/.agents/skills/x
//   3. front matter and HTML comments stripped; a body over skillMaxChars is skipped
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';

export interface Skill {
  name: string;
  body: string; // stripped SKILL.md
  size: number; // body.length: what is compared with skillMaxChars
}

/** null = the skill is available; a string = why not (logged, and the skill is dropped). */
export type SkillCheck = () => Promise<string | null>;

/** Skills that need more than a SKILL.md to work (a CLI on PATH, say) register a check here. */
export const SKILL_CHECKS: Record<string, SkillCheck> = {};

export const skillsHome = (): string => process.env.HX_SKILLS_HOME || os.homedir();

/** The SKILL.md locations for `name`, in precedence order. */
export function skillPaths(repo: string, name: string, home: string = skillsHome()): string[] {
  return [
    path.join(repo, '.claude', 'skills', name, 'SKILL.md'),
    path.join(home, '.claude', 'skills', name, 'SKILL.md'),
    path.join(repo, '.agents', 'skills', name, 'SKILL.md'),
  ];
}

/** A SKILL.md without its YAML front matter and HTML comments. */
export function stripSkill(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

export interface ResolvedSkills {
  byRole: Record<string, Skill[]>;
  lines: string[]; // what to log
}

/** Resolve every role's skills once; each skill name is checked and read at most once. */
export async function resolveSkills(repo: string, roleSkills: Record<string, string[]>, maxChars: number,
  opts: { checks?: Record<string, SkillCheck>; home?: string } = {}): Promise<ResolvedSkills> {
  const checks = opts.checks ?? SKILL_CHECKS;
  const home = opts.home ?? skillsHome();
  const lines: string[] = [];
  const cache = new Map<string, Skill | 'dropped' | 'missing' | 'big'>();
  const resolve = async (name: string): Promise<Skill | 'dropped' | 'missing' | 'big'> => {
    const check = Object.hasOwn(checks, name) ? checks[name] : undefined;
    if (check) {
      const why = await check();
      if (why !== null) { lines.push(why); return 'dropped'; }
    }
    const file = skillPaths(repo, name, home).find((f) => existsSync(f));
    if (!file) return 'missing';
    const body = stripSkill(readFileSync(file, 'utf8'));
    if (body.length > maxChars) {
      lines.push(`skill ${name} is ${body.length} chars, over skillMaxChars ${maxChars} — skipped`);
      return 'big';
    }
    return { name, body, size: body.length };
  };
  const byRole: Record<string, Skill[]> = {};
  for (const [role, names] of Object.entries(roleSkills)) {
    const got: Skill[] = [];
    for (const name of names ?? []) {
      if (!cache.has(name)) cache.set(name, await resolve(name));
      const r = cache.get(name)!;
      if (r === 'missing') lines.push(`skill ${name} not found — role ${role} runs without it`);
      else if (typeof r === 'object') got.push(r);
    }
    byRole[role] = got;
  }
  return { byRole, lines };
}

/** role → skill names, roles without a skill left out (what live.json records). */
export function skillNames(byRole: Record<string, Skill[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [role, skills] of Object.entries(byRole)) if (skills.length) out[role] = skills.map((s) => s.name);
  return out;
}

/** `impl ← rtdd, audit ← rtdd` (sizes, on a skill's first appearance, when given), or `none`. */
export function formatSkills(names: Record<string, string[]>, sizes?: Map<string, number>): string {
  const seen = new Set<string>();
  const roles = Object.entries(names).filter(([, s]) => s?.length).map(([role, skills]) => `${role} ← ${skills.map((n) => {
    const size = sizes?.get(n);
    const first = !seen.has(n);
    seen.add(n);
    return first && size !== undefined ? `${n} (${(size / 1000).toFixed(1)}K chars)` : n;
  }).join(', ')}`);
  return roles.length ? roles.join(', ') : 'none';
}

/** The run log's summary line: `skills: impl ← rtdd (7.4K chars), audit ← rtdd` or `skills: none`. */
export function skillsLogLine(byRole: Record<string, Skill[]>): string {
  const sizes = new Map(Object.values(byRole).flat().map((s) => [s.name, s.size] as const));
  return `skills: ${formatSkills(skillNames(byRole), sizes)}`;
}

/** The rendered prompt with each skill appended (`## Skill: <name>`, its body, then prompts/skills/<name>.md
 *  when present). Skill text is not rendered: `{{...}}` stays as written. No skills → the prompt unchanged. */
export function appendSkills(prompt: string, skills: Skill[], promptsDir: string): string {
  let out = prompt;
  for (const s of skills) {
    const notePath = path.join(promptsDir, 'skills', `${s.name}.md`);
    const note = existsSync(notePath) ? readFileSync(notePath, 'utf8').replace(/^﻿/, '').trim() : '';
    out += `${out.endsWith('\n') ? '' : '\n'}\n## Skill: ${s.name}\n${s.body}\n${note ? note + '\n' : ''}`;
  }
  return out;
}

/** rtdd's check: `.rtdd/config.yaml` on origin/<base> as last fetched (no fetch), then `<bin> --version`.
 *  Not set up → the binary is never spawned. */
export function rtddCheck(root: string, base: string, bin: string): SkillCheck {
  return async () => {
    const onOrigin = await run(process.env.HX_GIT_BIN || 'git', ['-C', root, 'cat-file', '-e', `origin/${base}:.rtdd/config.yaml`]);
    if (onOrigin.code !== 0) return `skill rtdd dropped: .rtdd/config.yaml is not on origin/${base} — run rtdd init and commit .rtdd/`;
    const v = await run(bin, ['--version'], { cwd: root });
    if (v.code !== 0) return `skill rtdd dropped: rtdd not found (\`${bin} --version\` failed: ${(v.stderr || v.stdout).trim().slice(0, 160) || `exit ${v.code}`})`;
    return null;
  };
}

/** A session's env with `bin`'s directory first on PATH when rtdd is active and `bin` is a path; else `env` itself.
 *  The key is the one the process env already uses (`Path` on Windows), so the session gets one PATH entry. */
export function rtddEnv(env: Record<string, string>, active: boolean, bin: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!active || !/[\\/]/.test(bin)) return env;
  const key = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const cur = base[key];
  return { ...env, [key]: path.dirname(path.resolve(bin)) + (cur ? path.delimiter + cur : '') };
}
