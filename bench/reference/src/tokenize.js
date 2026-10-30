// Reference solution: proves the hidden tests match the issue specs. Never shown to the agents.
export function tokenize(text) {
  return (text.match(/[\p{L}\p{N}']+/gu) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, '').toLowerCase())
    .filter(Boolean);
}
