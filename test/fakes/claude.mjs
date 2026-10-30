// Fake `claude -p --output-format stream-json`. It acts on the fake board (HX_FAKE_STATE) per role:
//   implement: turn 1 "working", turn 2 closes the issue and prints the promise (never, if the body says FAIL)
//   decompose: files two children (the second blocked by the first) and prints the promise
//   review:    round 1 files a gap issue; later rounds sign off. Both post the review comment.
// FAKE_CLAUDE_MODE=limit / crash for the error paths.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { locked } from './lock.mjs';

const a = process.argv.slice(2);
const sid = a[a.indexOf(a.includes('--resume') ? '--resume' : '--session-id') + 1];
const mode = process.env.FAKE_CLAUDE_MODE || 'work';
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 };
const boardFile = process.env.HX_FAKE_STATE;
const loadBoard = () => JSON.parse(readFileSync(boardFile, 'utf8'));
const saveBoard = (b) => { writeFileSync(boardFile + '.tmp', JSON.stringify(b, null, 2)); renameSync(boardFile + '.tmp', boardFile); };
const file = (b, title, body, labels) => {
  const number = Math.max(0, ...b.issues.map((i) => i.number)) + 1;
  b.issues.push({ number, title, body, state: 'OPEN', labels });
  return number;
};

let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
  if (mode === 'fatal') {
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, num_turns: 1, usage, total_cost_usd: 0,
      result: 'API Error: 400 Claude Code 2.1.150 does not support this model' });
    return;
  }
  if (mode === 'limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 4102444800 } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit", num_turns: 1, usage, total_cost_usd: 0 });
    return;
  }
  // the first prompt names the role and target; the continue prompt does not, so remember them
  const counter = path.join(process.env.HX_FAKE_DIR, `${sid}.json`);
  const st = existsSync(counter) ? JSON.parse(readFileSync(counter, 'utf8'))
    : { turns: 0, role: /Role: (\w+)/.exec(prompt)?.[1] ?? 'implement', n: Number(/(?:Issue|PRD): #(\d+)/.exec(prompt)?.[1]),
        round: Number(/review round (\d+)/.exec(prompt)?.[1] ?? 0) };
  st.turns++;
  writeFileSync(counter, JSON.stringify(st));
  writeFileSync(path.join(process.env.HX_FAKE_DIR, `${sid}.prompt-${st.turns}.txt`), prompt);
  if (a.includes('--resume') !== st.turns > 1) { process.stderr.write('resume flag mismatch'); process.exit(4); }
  const checkpoint = /HX CHECKPOINT/.test(prompt);
  // FAKE_CLAUDE_RATE=<0..1>: report that much of the five-hour window used, resetting in 2s
  if (process.env.FAKE_CLAUDE_RATE)
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: Number(process.env.FAKE_CLAUDE_RATE),
      resetsAt: Math.ceil(Date.now() / 1000) + 2, rateLimitType: 'five_hour' } });
  // FAKE_CLAUDE_DELAY_MS: a slow turn, so a test can pause or stop the run mid-session
  setTimeout(() => finish(st, checkpoint), checkpoint ? 0 : Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
});

function finish(st, checkpoint) {
  const done = () => `<promise>${st.role === 'implement' ? 'ISSUE' : st.role.toUpperCase()} ${st.n} DONE</promise>`;
  const text = locked(boardFile, () => {
    const b = loadBoard();
    const me = b.issues.find((i) => i.number === st.n);
    let t = `working on #${st.n} (turn ${st.turns}) in ${path.basename(process.cwd())}`;
    if (checkpoint) {
      b.comments.push({ issue: st.n, body: `<!-- hx-handoff -->\nhalf done; next: finish part ${st.n}` });
      t = `<promise>CHECKPOINT ${st.n} DONE</promise>`;
    } else if (st.role === 'implement' && st.turns >= 2 && !/FAIL/.test(me.body)) {
      me.state = 'CLOSED';
      t = `merged. ${done()}`;
    } else if (st.role === 'decompose') {
      const first = file(b, `part A of ${me.title}`, `do A\n\n## Blocked by\nNone\n\n## Parent\n#${st.n}\n`, ['ready-for-agent']);
      file(b, `part B of ${me.title}`, `do B\n\n## Blocked by\n#${first}\n\n## Parent\n#${st.n}\n`, ['ready-for-agent']);
      t = `filed 2 issues. ${done()}`;
    } else if (st.role === 'review') {
      if (st.round === 1) file(b, `gap in ${me.title}`, `fix gap\n\n## Blocked by\nNone\n\n## Parent\n#${st.n}\n`, ['ready-for-agent']);
      else me.labels.push('prd-reviewed');
      b.comments.push({ issue: st.n, body: `<!-- hx-review -->\nround ${st.round}` });
      t = `reviewed. ${done()}`;
    }
    saveBoard(b);
    return t;
  });
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, usage, total_cost_usd: 0.01 });
}
