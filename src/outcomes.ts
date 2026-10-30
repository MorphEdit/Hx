// Dashboard outcome numbers parsed from run.log text (the lines pool.ts log() writes). Pure: no I/O.

export interface Outcomes {
  audit: { pass: number; fail: number; mergedIssues: number; avgRounds: number | null };
  gauntlet: { rounds: number; pass: number; fail: number };
  security: { passes: number; filed: number[] };          // filed: unique issue numbers, ascending
  gate: { red: number; recovered: number; openRed: boolean; redMs: number[]; avgRedMs: number | null };
  issues: { done: number; medianMs: number | null };      // wall time from the first impl: line to DONE
}

// `<ISO> #<n> <msg>` or `<ISO> - <msg>`; anything else (a truncated first line, noise) is skipped
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:#(\d+)|-) (.*)$/;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function parseOutcomes(text: string): Outcomes {
  let pass = 0, fail = 0, gPass = 0, gFail = 0, secPasses = 0, red = 0, recovered = 0;
  const rounds: number[] = [], redMs: number[] = [], issueMs: number[] = [], filed = new Set<number>();
  const started = new Map<number, number>(); // issue → time of its first impl line, until its DONE
  let redSince: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) continue;
    const msg = m[3];
    if (m[2] === undefined) {
      if (msg.startsWith('gate RED ✗')) { if (redSince === null) { red++; redSince = t; } }
      else if (msg.startsWith('gate green ✓ again at ') && redSince !== null) { recovered++; redMs.push(t - redSince); redSince = null; }
      continue;
    }
    const n = Number(m[2]);
    let k: RegExpExecArray | null;
    if (msg.startsWith('audit PASS ✓')) pass++;
    else if (msg.startsWith('audit FAIL ✗')) fail++;
    else if ((k = /^gauntlet round \d+\/\d+: (PASS ✓|FAIL ✗)/.exec(msg))) { if (k[1].startsWith('PASS')) gPass++; else gFail++; }
    else if (msg.startsWith('security DONE ✓ (')) secPasses++;
    else if (msg.startsWith('security pass filed ')) {
      for (const f of msg.split(' — ')[0].matchAll(/#(\d+)/g)) filed.add(Number(f[1]));
    } else if (/^impl(?: \(round \d+\))?: /.test(msg)) { if (!started.has(n)) started.set(n, t); }
    else if ((k = /^DONE ✓ audited and merged \((\d+) round\(s\)/.exec(msg)) || msg.startsWith('impl DONE ✓ (')) {
      if (k) rounds.push(Number(k[1]));
      const s = started.get(n);
      if (s !== undefined) { issueMs.push(t - s); started.delete(n); }
    }
  }

  return {
    audit: { pass, fail, mergedIssues: rounds.length, avgRounds: mean(rounds) },
    gauntlet: { rounds: gPass + gFail, pass: gPass, fail: gFail },
    security: { passes: secPasses, filed: [...filed].sort((a, b) => a - b) },
    gate: { red, recovered, openRed: redSince !== null, redMs, avgRedMs: mean(redMs) },
    issues: { done: issueMs.length, medianMs: median(issueMs) },
  };
}
