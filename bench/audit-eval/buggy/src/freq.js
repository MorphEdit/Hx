import { tokenize } from './tokenize.js';

export function wordFreq(text, { top } = {}) {
  const counts = new Map();
  for (const w of tokenize(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const pairs = [...counts].sort((a, b) => b[1] - a[1]);
  return top ? pairs.slice(0, top) : pairs;
}
