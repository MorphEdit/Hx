// Fake `claude -p --output-format stream-json`. Behaviour, per issue named in the prompt:
//   turn 1 → "working", turn 2 → closes the issue in the fake board and prints the promise.
//   An issue whose body says FAIL never finishes. FAKE_CLAUDE_MODE=limit / crash for the error paths.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const a = process.argv.slice(2);
const sid = a[a.indexOf(a.includes('--resume') ? '--resume' : '--session-id') + 1];
const mode = process.env.FAKE_CLAUDE_MODE || 'work';
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 };

let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
  if (mode === 'limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 4102444800 } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit", num_turns: 1, usage, total_cost_usd: 0 });
    return;
  }
  // remember which issue this session is on: the continue prompt names it too
  const counter = path.join(process.env.HX_FAKE_DIR, `${sid}.json`);
  const st = existsSync(counter) ? JSON.parse(readFileSync(counter, 'utf8')) : { turns: 0, issue: Number(/#(\d+)/.exec(prompt)?.[1]) };
  st.turns++;
  writeFileSync(counter, JSON.stringify(st));
  if (a.includes('--resume') !== st.turns > 1) { process.stderr.write('resume flag mismatch'); process.exit(4); }

  const board = JSON.parse(readFileSync(process.env.HX_FAKE_STATE, 'utf8'));
  const issue = board.issues.find((i) => i.number === st.issue);
  let text = `working on #${st.issue} (turn ${st.turns}) in ${path.basename(process.cwd())}`;
  if (st.turns >= 2 && !/FAIL/.test(issue.body)) {
    issue.state = 'CLOSED';
    writeFileSync(process.env.HX_FAKE_STATE + '.tmp', JSON.stringify(board, null, 2));
    renameSync(process.env.HX_FAKE_STATE + '.tmp', process.env.HX_FAKE_STATE);
    text = `merged. <promise>ISSUE ${st.issue} DONE</promise>`;
  }
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, usage, total_cost_usd: 0.01 });
});
