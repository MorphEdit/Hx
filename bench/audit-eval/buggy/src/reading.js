import { tokenize } from './tokenize.js';

export function readingTime(text, wpm = 200) {
  return Math.ceil(tokenize(text).length / wpm);
}
