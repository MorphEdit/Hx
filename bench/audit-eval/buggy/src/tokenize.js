export function tokenize(text) {
  return (text.match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.toLowerCase()).filter(Boolean);
}
