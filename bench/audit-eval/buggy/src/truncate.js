export function truncate(text, max, suffix = '…') {
  if (max < suffix.length) throw new RangeError('max is shorter than the suffix');
  if (text.length <= max) return text;
  let best = '';
  for (const m of text.matchAll(/\s/g)) {
    const prefix = text.slice(0, m.index).trimEnd();
    if (prefix && prefix.length + suffix.length <= max && prefix.length > best.length) best = prefix;
  }
  return (best || text.slice(0, max)) + suffix;
}
