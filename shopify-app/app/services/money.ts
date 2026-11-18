// Money conversion between Shopify's decimal strings and integer cents.
//
// Shopify sends money as strings with a variable number of decimals ("21",
// "21.5", "21.50", "9.0"). Conversion is by string arithmetic only: going
// through a float ("21.5" * 100) is how 1.005 becomes 100 cents instead of
// 101. Nothing here decides a price; it only changes representation.

import type { Cents } from "./types";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "21.5" -> 2150. Throws on negatives, garbage, or sub-cent precision. */
export function toCents(amount: string): Cents {
  if (typeof amount !== "string") {
    throw new Error(`Not a money string: ${String(amount)}`);
  }
  const m = DECIMAL.exec(amount);
  if (!m) {
    throw new Error(`Not a valid non-negative money amount: "${amount}"`);
  }
  const whole = m[1];
  const fraction = m[2] ?? "";
  // Shopify pads with zeros ("21.500"); anything else would lose a fraction of
  // a cent, which is a rejection, never a rounding.
  if (/[^0]/.test(fraction.slice(2))) {
    throw new Error(`More than 2 decimal places: "${amount}"`);
  }
  const cents = Number(whole + fraction.slice(0, 2).padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Amount out of range: "${amount}"`);
  }
  return cents;
}

/** 2150 -> "21.50". The format Shopify accepts and the UI displays. */
export function formatCents(cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`Not a valid cents amount: ${cents}`);
  }
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * Like toCents but drops digits beyond the cent instead of rejecting them. For
 * comparison only (a per-unit discounted price can carry fractions of a cent);
 * never use the result as a price to write.
 */
export function toCentsTruncated(amount: string): Cents {
  const m = DECIMAL.exec(amount);
  if (!m) {
    throw new Error(`Not a valid non-negative money amount: "${amount}"`);
  }
  const cents = Number(m[1] + (m[2] ?? "").slice(0, 2).padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Amount out of range: "${amount}"`);
  }
  return cents;
}
