/**
 * Shared booking-money helpers — single source of truth for the
 * Decimal-string ↔ integer-minor-units conversions every booking
 * write/read path uses (CLAUDE.md §6, §17.6 — no floats for money).
 *
 * Phase-1 callers:
 *   - `bookings.service.ts` (createBooking)
 *   - `lifecycle/build-transition-event-payload.ts` (BOOKING_COMPLETED event payload)
 *   - `bookings/mappers/booking.mapper.ts` (public BookingResponse DTO)
 *   - `recurrence.service.ts` (createRecurringSeries occurrence rows)
 *   - `admin/mappers/admin-booking.mapper.ts` (admin AdminBookingSummary/Detail DTOs)
 *
 * All five copies were verbatim apart from error-message prefixes;
 * consolidating them in TS-063-followup-8 defuses the drift risk that
 * each new caller (TS-065 disputes, the future TS-128-followup-2 admin
 * cancel/refund flow) would otherwise compound.
 *
 * The persistence shape is `Decimal(12,2)` for money columns and
 * `Decimal(5,4)` for the commission-rate column. The wire shape is
 * integer minor units (cents) and integer basis points respectively.
 * These helpers cross that boundary in both directions exactly once
 * per row per request (CLAUDE.md §6 — "Round once, at presentation").
 */

/**
 * Parse a `Decimal(12,2)` Postgres string (`"150.00"`, `"-99.05"`,
 * `"0.00"`) into integer minor units (cents). Uses pure integer math
 * — split on `.` and accumulate in integer space — so float-precision
 * artefacts cannot land in the persisted row or the event payload.
 *
 * 15000 → 15000  ("150.00" → 15000)
 * Throws on a non-numeric input so a malformed Postgres row surfaces
 * loudly rather than poisoning the response.
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
 * Postgres expects on the way in. 15000 → "150.00", -9905 → "-99.05".
 */
export function minorToDecimalString(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${negative ? '-' : ''}${dollars}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Parse a `Decimal(5,4)` Postgres string (`"0.3000"`, `"1.0000"`,
 * `"0.0000"`) into integer basis points (0..10000). Same pure-integer
 * approach as `decimalStringToMinor`.
 *
 * "0.3000" → 3000
 */
export function ratioStringToBps(value: string): number {
  const [whole, fraction = '0'] = value.split('.');
  const wholeInt = Number.parseInt(whole ?? '0', 10);
  const paddedFraction = fraction.padEnd(4, '0').slice(0, 4);
  const fractionInt = Number.parseInt(paddedFraction, 10);
  if (Number.isNaN(wholeInt) || Number.isNaN(fractionInt)) {
    throw new Error(`ratioStringToBps: invalid ratio '${value}'`);
  }
  return wholeInt * 10_000 + fractionInt;
}

/**
 * Convert an integer basis-points commission rate (0..10000) to the
 * `Decimal(5,4)` string the persistence layer expects. 3000 → "0.3000".
 */
export function ratioFromBps(bps: number): string {
  const integer = Math.floor(bps / 10_000);
  const fraction = bps % 10_000;
  return `${integer}.${fraction.toString().padStart(4, '0')}`;
}

/**
 * Compute the commission amount in minor units from a base amount in
 * minor units and a rate in basis points. Single `Math.round`-half-up
 * step at the cent boundary — the same rounding convention the
 * accounting recognizer expects (booking-commission receiver per PDD
 * Appendix A). Per CLAUDE.md §6: "Round once, at presentation."
 *
 * 15000 minor × 3000 bps → 4500 minor.
 */
export function computeCommissionMinor(baseMinor: number, rateBps: number): number {
  return Math.round((baseMinor * rateBps) / 10_000);
}
