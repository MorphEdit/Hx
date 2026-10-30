// Dashboard outcome numbers parsed from run.log lines (the lines pool.ts log() writes). Pure: no I/O.

export interface Outcomes {
  audit: { pass: number; fail: number; mergedIssues: number; avgRounds: number | null };
  gauntlet: { rounds: number; pass: number; fail: number };
  security: { passes: number; filed: number };            // filed: passes that filed issue(s)
  gate: { red: number; recovered: number; openRed: boolean; redMs: number[]; avgRedMs: number | null };
  issues: { done: number; medianMs: number | null };      // wall time from the first impl: line to DONE
}

// `<ISO> [#<n>] <msg>` or `<ISO> <msg>`; a line that does not start with an ISO timestamp is skipped
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[#(\d+)\] )?(.*)$/;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function parseOutcomes(lines: string[]): Outcomes {
  let pass = 0, fail = 0, gPass = 0, gFail = 0, secPasses = 0, filed = 0, red = 0;
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
    else if (msg.startsWith('security pass filed issue(s)')) filed++;
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
  };
}
