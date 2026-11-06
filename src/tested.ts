// .hx/tested-trees.jsonl (#351): one line per full run of a test command, so a run on a tree that already passed can
// be skipped (ship --resume; the gate is a sibling issue). HX_TESTED_TREES names the file; scripts/ship.mjs imports this.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TESTED_TREES_FILE = 'tested-trees.jsonl';

/** One full run: `tree` = `git rev-parse <commit>^{tree}`, `command` = the exact test command, `ok` false for a fail or a timeout. */
export interface TreeRecord { tree: string; command: string; ok: boolean; at: string }

/** Every well-formed record in the file, oldest first; a missing file is none, a malformed line is skipped. */
export function readTestedTrees(file: string): TreeRecord[] {
  if (!existsSync(file)) return [];
  const out: TreeRecord[] = [];
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r.tree === 'string' && typeof r.command === 'string' && typeof r.ok === 'boolean' && typeof r.at === 'string')
        out.push({ tree: r.tree, command: r.command, ok: r.ok, at: r.at });
    } catch {}
  }
  return out;
}

/** Appends one record (never rewrites the file). */
export function appendTestedTree(file: string, r: TreeRecord): void {
  appendFileSync(file, JSON.stringify({ tree: r.tree, command: r.command, ok: r.ok, at: r.at }) + '\n');
}

/** The latest record for a tree and command: only it counts. */
export function latestTreeRecord(recs: TreeRecord[], tree: string, command: string): TreeRecord | undefined {
  return recs.findLast((r) => r.tree === tree && r.command === command);
}

/** The record that lets a run be skipped: the latest one for the tree and command, when it is a pass; else null. */
export function passedTree(file: string, tree: string, command: string): TreeRecord | null {
  const r = latestTreeRecord(readTestedTrees(file), tree, command);
  return r?.ok ? r : null;
}

/** The env entry hx sets for sessions and its ship --resume: HX_TESTED_TREES = the absolute path, or nothing with reuseTestedTrees off. */
export function testedTreesEnv(stateDir: string, c: { reuseTestedTrees: boolean }): Record<string, string> {
  return c.reuseTestedTrees === false ? {} : { HX_TESTED_TREES: path.resolve(stateDir, TESTED_TREES_FILE) };
}

/** What is wrong with config.reuseTestedTrees, or null when it is valid (unset included). */
export function reuseTestedTreesError(v: unknown): string | null {
  return v === undefined || typeof v === 'boolean' ? null : `reuseTestedTrees: ${JSON.stringify(v)} must be true or false`;
}
