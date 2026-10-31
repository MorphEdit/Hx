// A fake non-claude agent CLI for the AgentCli seam: prints its argv and stdin as plain `key=value` lines.
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  console.log(`args=${JSON.stringify(process.argv.slice(2))}`);
  console.log(`said=${input}`);
  console.log('limit=0.95');
  console.log('noise');
  process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 0));
});
