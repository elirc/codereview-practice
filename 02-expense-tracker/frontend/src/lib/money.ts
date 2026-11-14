export type ParseResult = { ok: true; minor: number } | { ok: false; error: string };

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d*))?$/;
const MAX_SAFE_DIGITS = 15;

function tooManyDecimals(exponent: number): string {
  if (exponent === 0) {
    return "This currency has no decimal places.";
  }
  return `Use at most ${exponent} decimal places.`;
}

/**
 * Parse a user-entered amount such as "12.34" into integer minor units, using only
 * string operations so no binary floating point is involved.
 */
export function parseMinor(input: string, exponent: number): ParseResult {
  const match = AMOUNT_PATTERN.exec(input.trim());
  if (!match) {
    return { ok: false, error: "Enter an amount such as 12.34." };
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    return { ok: false, error: tooManyDecimals(exponent) };
  }
  const digits = (whole + fraction.padEnd(exponent, "0")).replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_SAFE_DIGITS) {
    return { ok: false, error: "That amount is too large." };
  }
  return { ok: true, minor: Number(digits) };
}

/** Render integer minor units as a decimal string with exactly `exponent` places. */
export function formatMinor(minor: number, exponent: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`not an integer amount: ${minor}`);
  }
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString();
  if (exponent === 0) {
    return sign + digits;
  }
  const padded = digits.padStart(exponent + 1, "0");
  return `${sign}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

export function formatMoney(minor: number, currency: string, exponent: number): string {
  return `${formatMinor(minor, exponent)} ${currency}`;
}
