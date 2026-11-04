// Dashboard outcome numbers parsed from run.log lines (the lines pool.ts log() writes). Pure: no I/O.

export interface Outcomes {
  audit: { pass: number; fail: number; mergedIssues: number; avgRounds: number | null };
  gauntlet: { rounds: number; pass: number; fail: number };
  security: { passes: number; filed: number };            // filed: passes that filed issue(s)
  gate: { red: number; recovered: number; openRed: boolean; redMs: number[]; avgRedMs: number | null };
  issues: { done: number; medianMs: number | null };      // wall time from the first impl: line to DONE
  triage: { reproduced: number; needsInfo: number; failed: number; gaveUp: number };
  modelMismatch: number;                                   // `model mismatch:` lines (one per mismatched session)
  releases: { count: number; latest: string | null };      // `released vX.Y.Z (PRD #n[, #m…])` / `(fixes)` lines; latest: the last one's version
  health: { passes: number; fixed: number; filed: number }; // `health: …` lines; fixed / filed: the n of `fixed <n> (` / `filed <n> (`
  selfReview: { sessions: number; findings: number };      // `self-review: filed <k> finding(s) since <sha>` / `self-review: no findings since <sha>`
}

// `<ISO> [#<n>] <msg>` or `<ISO> <msg>`; a line that does not start with an ISO timestamp is skipped
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[#(\d+)\] )?(.*)$/;

// `released v0.3.0 (PRD #129)`, `released v0.3.0 (PRD #129, #139)`, `released v0.3.0 (fixes)` (PRD #139 §D11)
const RELEASED = /^released (v\d+\.\d+\.\d+) \((?:PRD #\d+(?:, #\d+)*|fixes)\)/;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function parseOutcomes(lines: string[]): Outcomes {
  let pass = 0, fail = 0, gPass = 0, gFail = 0, secPasses = 0, filed = 0, red = 0;
  let reproduced = 0, needsInfo = 0, tFailed = 0, gaveUp = 0, modelMismatch = 0, releases = 0;
  let latest: string | null = null;
  let hPasses = 0, hFixed = 0, hFiled = 0, srSessions = 0, srFindings = 0;
  const rounds: number[] = [], redMs: number[] = [], issueMs: number[] = [];
  const started = new Map<number, number>(); // issue → time of its first impl line, until its DONE
  let reds: number[] = [];                    // REDs not yet paired with a `gate green ✓ again`
  let lastRedPaired = true;

  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) continue;
    const n = m[2] === undefined ? null : Number(m[2]), msg = m[3];
    let k: RegExpExecArray | null;
    if (msg.startsWith('gate RED ✗')) { red++; reds.push(t); lastRedPaired = false; }
    else if (msg.startsWith('gate green ✓ again')) { for (const r of reds) redMs.push(t - r); if (reds.length) lastRedPaired = true; reds = []; }
    else if (msg.startsWith('audit PASS ✓')) pass++;
    else if (msg.startsWith('audit FAIL ✗')) fail++;
    else if ((k = /^gauntlet round \d+\/\d+: (PASS ✓|FAIL ✗)/.exec(msg))) { if (k[1].startsWith('PASS')) gPass++; else gFail++; }
    else if (msg.startsWith('security DONE ✓')) secPasses++;
    else if (msg.startsWith('security pass filed ')) filed++;
    else if (msg.startsWith('triage: REPRODUCED ✓')) reproduced++;
    else if (msg.startsWith('triage: NEEDS-INFO')) needsInfo++;
    else if (msg.startsWith('triage: FAILED')) tFailed++;
    else if (msg.startsWith('triage: GAVE UP')) gaveUp++;           // `triage: round cap reached` is not a give-up
    else if (msg.startsWith('model mismatch: ')) modelMismatch++;
    else if ((k = RELEASED.exec(msg))) { releases++; latest = k[1]; }
    else if (msg.startsWith('health: ')) {
      hPasses++;
      hFixed += Number(/ fixed (\d+) \(/.exec(msg)?.[1] ?? 0);
      hFiled += Number(/ filed (\d+) \(/.exec(msg)?.[1] ?? 0);
    }
    else if ((k = /^self-review: filed (\d+) finding\(s\) since \S+/.exec(msg))) { srSessions++; srFindings += Number(k[1]); }
    else if (/^self-review: no findings since \S+/.test(msg)) srSessions++;
    else if (msg.startsWith('impl: ') || msg.startsWith('impl (round ')) { if (n !== null && !started.has(n)) started.set(n, t); }
    else if ((k = /^DONE ✓ audited and merged(?: \((\d+) round\(s\))?/.exec(msg)) || msg.startsWith('impl DONE ✓')) {
      if (k?.[1] !== undefined) rounds.push(Number(k[1]));
      const s = n === null ? undefined : started.get(n);
      if (s !== undefined) { issueMs.push(t - s); started.delete(n!); }
    }
  }

  return {
    audit: { pass, fail, mergedIssues: rounds.length, avgRounds: mean(rounds) },
    gauntlet: { rounds: gPass + gFail, pass: gPass, fail: gFail },
    security: { passes: secPasses, filed },
    gate: { red, recovered: redMs.length, openRed: !lastRedPaired, redMs, avgRedMs: mean(redMs) },
    issues: { done: issueMs.length, medianMs: median(issueMs) },
    triage: { reproduced, needsInfo, failed: tFailed, gaveUp },
    modelMismatch,
    releases: { count: releases, latest },
    health: { passes: hPasses, fixed: hFixed, filed: hFiled },
    selfReview: { sessions: srSessions, findings: srFindings },
  };
}
