import { tokenize } from './tokenize.js';

export function readingTime(text, wpm = 200) {
  if (typeof wpm !== 'number' || !(wpm > 0)) throw new RangeError('wpm must be a number greater than 0');
  return Math.ceil(tokenize(text).length / wpm);
}
