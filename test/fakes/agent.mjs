// A fake non-claude agent CLI for the AgentCli seam: prints its argv and stdin as plain `key=value` lines.
// `--version` (hx doctor, hx run's startup checks)
if (process.argv[2] === '--version') { console.log('fake-agent 1.0.0'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  console.log(`args=${JSON.stringify(process.argv.slice(2))}`);
  console.log(`said=${input}`);
  console.log('limit=0.95');
  console.log('noise');
  process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0));
});
