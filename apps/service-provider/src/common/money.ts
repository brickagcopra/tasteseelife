/**
 * Money helpers for the provider-pricing surface (TS-204) — the
 * Decimal-string ↔ integer-minor-units conversions the pricing
 * write/read path uses (CLAUDE.md §4.1, §6, §17.6 — no floats for
 * money).
 *
 * The persistence shape for `providers.hourly_rate` is `Decimal(12,2)`;
 * the wire shape is integer minor units (cents). These helpers cross
 * that boundary in both directions exactly once per row per request
 * (CLAUDE.md §6 — "Round once, at presentation"). Mirrors the canonical
 * `apps/service-booking/src/common/money.ts`; kept local rather than
 * lifted to a shared package because only two services need it today
 * and a `packages/money` extraction is its own ADR.
 */

/**
 * Parse a `Decimal(12,2)` Postgres string (`"75.00"`, `"0.00"`) into
 * integer minor units (cents). Pure integer math — split on `.` and
 * accumulate in integer space — so float-precision artefacts cannot
 * land in the response. Throws on a non-numeric input so a malformed
 * row surfaces loudly rather than poisoning the response.
 *
 * "75.00" → 7500
 */
export function decimalStringToMinor(value: string): number {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const [dollars, cents = '00'] = abs.split('.');
  const paddedCents = cents.padEnd(2, '0').slice(0, 2);
  const dollarsInt = Number.parseInt(dollars ?? '0', 10);
  const centsInt = Number.parseInt(paddedCents, 10);
  if (Number.isNaN(dollarsInt) || Number.isNaN(centsInt)) {
    throw new Error(`decimalStringToMinor: invalid decimal '${value}'`);
  }
  const minor = dollarsInt * 100 + centsInt;
  return negative ? -minor : minor;
}

/**
 * Convert an integer minor-unit amount to the `Decimal(12,2)` string
 * Postgres expects on the way in. 7500 → "75.00".
 */
export function minorToDecimalString(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${negative ? '-' : ''}${dollars}.${cents.toString().padStart(2, '0')}`;
}
