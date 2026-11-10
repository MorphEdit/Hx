// Amounts. ledge keeps every amount as a whole number of cents, so adding them up is exact and nothing is ever
// rounded. The text form has exactly two decimals and an optional leading minus: `42.10`, `-7.00`, `0.50`.

const AMOUNT = /^-?\d+\.\d{2}$/;

/** Whether `text` is written as an amount: an optional minus, digits, a dot and exactly two digits. */
export function isAmount(text) {
  return typeof text === 'string' && AMOUNT.test(text);
}

/**
 * The cents of an amount's text. `007.50` is 750 and `-0.00` is 0 (never minus zero).
 * Throws an Error for text that is not an amount, or one too large to count exactly.
 */
export function parseAmount(text) {
  if (!isAmount(text)) {
    throw new Error(`not an amount: ${JSON.stringify(text)}`);
  }
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [whole, fraction] = digits.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`amount too large: ${text}`);
  }
  if (cents === 0) {
    return 0;
  }
  return negative ? -cents : cents;
}

/**
 * The text of an amount of cents, as ledge prints it: a minus for a negative amount, no leading zeros, two
 * decimals, and zero as `0.00`.
 */
export function formatAmount(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`not a whole number of cents: ${cents}`);
  }
  const negative = cents < 0;
  const size = Math.abs(cents);
  const whole = Math.floor(size / 100);
  const fraction = size % 100;
  const text = `${whole}.${String(fraction).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** The sum of a list of cents. */
export function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

/** The amount with its sign turned over, never minus zero. */
export function negate(cents) {
  return cents === 0 ? 0 : -cents;
}

/**
 * `numerator / denominator` rounded to a whole number, a half rounded up toward the larger number, for whole numbers
 * with a positive denominator. Exact: it never divides in floating point.
 */
export function roundHalfUp(numerator, denominator) {
  if (!(denominator > 0)) {
    throw new Error('the denominator must be positive');
  }
  // floor((2n + d) / 2d), with a floor that is right for negative numbers too
  const top = 2 * numerator + denominator;
  const bottom = 2 * denominator;
  const rest = ((top % bottom) + bottom) % bottom;
  return (top - rest) / bottom;
}
