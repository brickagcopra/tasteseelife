import { err, ok, type Result } from '../../common/result';

/**
 * RFC 5545 RRULE expander — Phase-1 subset (TS-061; PRD §6.3).
 *
 * Pure TS — no external dependencies. Expands an RRULE string into a
 * finite list of occurrence start dates anchored on a caller-supplied
 * `dtstart`. The visit duration (`scheduledEnd - scheduledStart`)
 * applies to every occurrence and is computed by the caller; this
 * expander only emits start dates.
 *
 * # Supported subset
 *
 * The expander recognises exactly the clauses PRD §6.3 calls for —
 * weekly, biweekly, monthly recurring visits with a finite
 * termination. Concretely:
 *
 *   - `FREQ=WEEKLY`    + optional `INTERVAL=N` (N ∈ [1, 4])
 *   - `FREQ=MONTHLY`   + optional `INTERVAL=N` (N ∈ [1, 12])
 *   - termination: `COUNT=N` (N ∈ [1, 52]) OR
 *                  `UNTIL=YYYYMMDDTHHMMSSZ` (RFC 5545 basic-format UTC)
 *
 * Daily / yearly frequencies and BYxxx / WKST / BYSETPOS / RDATE /
 * EXDATE / TZID clauses surface a typed `unsupported_clause` failure
 * so future RFC 5545 coverage can land additively (TS-061-followup-1).
 *
 * # Semantics
 *
 * - The anchor `dtstart` is ALWAYS the first occurrence (position 0).
 *   RFC 5545 calls this the implicit DTSTART. The expander never
 *   skips the anchor and never emits a date before it.
 *
 * - WEEKLY:  occurrence n = dtstart + n * INTERVAL * 7 days.
 *            UTC milliseconds arithmetic (no DST surprises — the
 *            booking row stores `Timestamptz(6)`; UTC math is the
 *            correct semantic for "every Tuesday at 6pm UTC").
 *
 * - MONTHLY: occurrence n = dtstart with month advanced by
 *            n * INTERVAL months, preserving day-of-month + UTC
 *            hour/minute/second. If the target month is shorter
 *            (e.g. anchor on Jan 31, next month is February), the
 *            expander **skips** that occurrence rather than clamping
 *            to the last day of the shorter month — Phase-1 product
 *            decision per PRD §6.3 ("monthly on the same day"). The
 *            skipped occurrence does NOT count toward COUNT; the
 *            expander emits a `monthly_day_overflow` warning the
 *            service uses for telemetry. Skipping is the
 *            conservative choice — a senior on a Jan-31 cadence who
 *            also wants a Feb 28 visit can model that as two
 *            separate series (or wait for the BYMONTHDAY follow-up).
 *
 * # Termination
 *
 * - COUNT=N: emit at most N occurrences total (including the
 *            anchor). Phase-1 cap N ≤ 52 (one year of weekly visits).
 * - UNTIL:   emit occurrences up to and including the UNTIL instant
 *            (RFC 5545 says "occurrences happening on or before").
 *            UTC basic-format only (e.g. `20260813T180000Z`).
 *
 * Exactly one of COUNT / UNTIL must be present — RRULEs that carry
 * both, or neither, surface `unsupported_termination` failures.
 *
 * # Hard cap
 *
 * The expander enforces `MAX_OCCURRENCES = 52` regardless of COUNT /
 * UNTIL — even an UNTIL clause that would emit more than 52
 * occurrences is truncated and the expander emits an
 * `occurrence_cap_reached` warning. Caps the write transaction
 * runtime + the outbox-event volume per request. Mirrors the
 * `RECURRENCE_MAX_OCCURRENCES` constant in the contract.
 *
 * # Why pure TS (not the `rrule` npm library)
 *
 * The Phase-1 product surface (weekly, biweekly, monthly with COUNT
 * or UNTIL) is small enough that a pure-TS expander stays under 200
 * lines + 100% testable + zero new dependencies. CLAUDE.md §13 lists
 * approved libraries and `rrule` is not on it; per CLAUDE.md §16 we
 * picked the in-house path with the user's confirmation. The future
 * upgrade path: when a Phase-2 product need requires BYDAY /
 * BYMONTHDAY / RDATE clauses, swap in `rrule` with approval (the
 * RRULE string is stored verbatim so the data layer survives the
 * swap).
 */

/** Hard cap on materialised occurrences per call. Mirrors the contract. */
export const MAX_OCCURRENCES = 52;

export type RruleFrequency = 'WEEKLY' | 'MONTHLY';

export interface ParsedRrule {
  readonly freq: RruleFrequency;
  readonly interval: number;
  readonly count: number | null;
  readonly until: Date | null;
}

export type RruleExpanderFailure =
  | { readonly reason: 'malformed_rrule'; readonly message: string }
  | { readonly reason: 'unsupported_clause'; readonly clause: string; readonly message: string }
  | { readonly reason: 'unsupported_frequency'; readonly freq: string }
  | { readonly reason: 'invalid_interval'; readonly value: string; readonly message: string }
  | { readonly reason: 'invalid_count'; readonly value: string; readonly message: string }
  | { readonly reason: 'invalid_until'; readonly value: string; readonly message: string }
  | { readonly reason: 'unsupported_termination'; readonly message: string };

export interface RruleExpansion {
  readonly parsed: ParsedRrule;
  readonly occurrences: ReadonlyArray<Date>;
  readonly warnings: ReadonlyArray<RruleExpansionWarning>;
}

export type RruleExpansionWarning =
  | { readonly kind: 'monthly_day_overflow'; readonly skippedAt: Date }
  | { readonly kind: 'occurrence_cap_reached' };

/**
 * Parse a Phase-1 RRULE string. Pure validation — no expansion. The
 * caller pairs the parsed rule with a `dtstart` and invokes
 * `expand(parsed, dtstart)` to materialise the occurrence list.
 *
 * Whitespace tolerance: the parser strips a single optional `RRULE:`
 * prefix (RFC 5545's content-line prefix) and trims surrounding
 * whitespace. Internal whitespace inside clause values is rejected.
 */
export function parseRrule(input: string): Result<ParsedRrule, RruleExpanderFailure> {
  if (typeof input !== 'string' || input.length === 0) {
    return err({ reason: 'malformed_rrule', message: 'RRULE must be a non-empty string' });
  }
  // Strip the optional `RRULE:` content-line prefix. RFC 5545 allows
  // the bare clause-list form too.
  const stripped = input.trim().replace(/^RRULE:/i, '');
  if (stripped.length === 0) {
    return err({ reason: 'malformed_rrule', message: 'RRULE body is empty' });
  }

  const clauses = stripped.split(';');
  let freq: RruleFrequency | null = null;
  let interval = 1;
  let count: number | null = null;
  let until: Date | null = null;

  for (const raw of clauses) {
    const clause = raw.trim();
    if (clause.length === 0) {
      return err({ reason: 'malformed_rrule', message: 'empty clause in RRULE' });
    }
    const eq = clause.indexOf('=');
    if (eq <= 0 || eq === clause.length - 1) {
      return err({
        reason: 'malformed_rrule',
        message: `clause '${clause}' is not in NAME=VALUE form`,
      });
    }
    const name = clause.slice(0, eq).toUpperCase();
    const value = clause.slice(eq + 1);

    switch (name) {
      case 'FREQ':
        if (value !== 'WEEKLY' && value !== 'MONTHLY') {
          return err({ reason: 'unsupported_frequency', freq: value });
        }
        freq = value;
        break;
      case 'INTERVAL': {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1 || String(n) !== value) {
          return err({
            reason: 'invalid_interval',
            value,
            message: 'INTERVAL must be a positive integer',
          });
        }
        interval = n;
        break;
      }
      case 'COUNT': {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1 || String(n) !== value) {
          return err({
            reason: 'invalid_count',
            value,
            message: 'COUNT must be a positive integer',
          });
        }
        if (n > MAX_OCCURRENCES) {
          return err({
            reason: 'invalid_count',
            value,
            message: `COUNT must be ≤ ${MAX_OCCURRENCES}`,
          });
        }
        count = n;
        break;
      }
      case 'UNTIL': {
        const parsed = parseUntilUtc(value);
        if (parsed === null) {
          return err({
            reason: 'invalid_until',
            value,
            message: 'UNTIL must be RFC 5545 basic-format UTC (YYYYMMDDTHHMMSSZ)',
          });
        }
        until = parsed;
        break;
      }
      default:
        return err({
          reason: 'unsupported_clause',
          clause: name,
          message: `Phase-1 subset does not support '${name}'; see TS-061 doc-comment`,
        });
    }
  }

  if (freq === null) {
    return err({ reason: 'malformed_rrule', message: 'FREQ clause is required' });
  }

  // Frequency-specific INTERVAL bounds.
  if (freq === 'WEEKLY' && interval > 4) {
    return err({
      reason: 'invalid_interval',
      value: String(interval),
      message: 'WEEKLY INTERVAL must be ≤ 4 (weekly, biweekly, triweekly, monthly-by-week)',
    });
  }
  if (freq === 'MONTHLY' && interval > 12) {
    return err({
      reason: 'invalid_interval',
      value: String(interval),
      message: 'MONTHLY INTERVAL must be ≤ 12',
    });
  }

  if (count === null && until === null) {
    return err({
      reason: 'unsupported_termination',
      message: 'RRULE must carry exactly one of COUNT or UNTIL',
    });
  }
  if (count !== null && until !== null) {
    return err({
      reason: 'unsupported_termination',
      message: 'RRULE must carry exactly one of COUNT or UNTIL (not both)',
    });
  }

  return ok({ freq, interval, count, until });
}

/**
 * Expand a parsed RRULE anchored on `dtstart` into a list of
 * occurrence start dates. The anchor is always position 0.
 *
 * Returns the materialised occurrence list bounded by COUNT / UNTIL /
 * the global `MAX_OCCURRENCES` cap, plus any expansion warnings the
 * service might surface for telemetry.
 *
 * Pure function — same inputs produce the same outputs. No I/O.
 */
export function expandRrule(parsed: ParsedRrule, dtstart: Date): RruleExpansion {
  const occurrences: Date[] = [];
  const warnings: RruleExpansionWarning[] = [];

  if (parsed.until !== null && dtstart.getTime() > parsed.until.getTime()) {
    // The anchor is past UNTIL — emit zero occurrences. Caller-side
    // validation should reject this upstream; defence-in-depth.
    return { parsed, occurrences: [], warnings: [] };
  }

  const maxByCount = parsed.count ?? MAX_OCCURRENCES;
  const limit = Math.min(maxByCount, MAX_OCCURRENCES);

  if (parsed.freq === 'WEEKLY') {
    const stepMs = parsed.interval * 7 * 24 * 60 * 60 * 1000;
    let cursor = dtstart.getTime();
    let i = 0;
    while (i < limit) {
      const at = new Date(cursor);
      if (parsed.until !== null && at.getTime() > parsed.until.getTime()) break;
      occurrences.push(at);
      i += 1;
      cursor += stepMs;
    }
  } else {
    // MONTHLY. Walk the calendar in UTC, advancing the month by
    // `interval` each step. Preserve day-of-month / hour / minute /
    // second / ms exactly. If the target month is shorter, skip
    // (Phase-1 product decision — see doc-comment).
    const anchorYear = dtstart.getUTCFullYear();
    const anchorMonth = dtstart.getUTCMonth();
    const anchorDay = dtstart.getUTCDate();
    const anchorHour = dtstart.getUTCHours();
    const anchorMin = dtstart.getUTCMinutes();
    const anchorSec = dtstart.getUTCSeconds();
    const anchorMs = dtstart.getUTCMilliseconds();

    let emitted = 0;
    // We walk the schedule by `step` (months from anchor) — not by
    // emitted-count — so a skipped overflow month does NOT use a
    // termination slot. The walk terminates when emitted == limit OR
    // when UNTIL is exceeded. We bound the step loop at limit *
    // interval * 2 (max possible walk if every other month overflows)
    // to keep the loop finite under pathological inputs.
    const maxSteps = limit * Math.max(1, parsed.interval) * 2;
    for (let step = 0; step < maxSteps && emitted < limit; step += 1) {
      const targetYear = anchorYear + Math.floor((anchorMonth + step * parsed.interval) / 12);
      const targetMonth = (((anchorMonth + step * parsed.interval) % 12) + 12) % 12;
      // Validate the target day exists in the target month.
      const daysInTargetMonth = daysInMonthUtc(targetYear, targetMonth);
      if (anchorDay > daysInTargetMonth) {
        // Shorter month overflow — skip and record a warning the
        // service can surface for telemetry.
        const skippedAt = new Date(
          Date.UTC(
            targetYear,
            targetMonth,
            daysInTargetMonth,
            anchorHour,
            anchorMin,
            anchorSec,
            anchorMs,
          ),
        );
        warnings.push({ kind: 'monthly_day_overflow', skippedAt });
        continue;
      }
      const at = new Date(
        Date.UTC(targetYear, targetMonth, anchorDay, anchorHour, anchorMin, anchorSec, anchorMs),
      );
      if (parsed.until !== null && at.getTime() > parsed.until.getTime()) break;
      occurrences.push(at);
      emitted += 1;
    }
  }

  // Cap warning — only if the loop exited because of the global cap,
  // not because COUNT or UNTIL terminated it naturally.
  if (parsed.count === null && occurrences.length === MAX_OCCURRENCES && parsed.until !== null) {
    // We hit MAX_OCCURRENCES with an UNTIL termination. The walk
    // might still have had more candidate dates ≤ UNTIL; emit the
    // cap warning so the service surfaces it for telemetry.
    warnings.push({ kind: 'occurrence_cap_reached' });
  }

  return { parsed, occurrences, warnings };
}

/**
 * Parse the RFC 5545 basic-format UTC datetime (e.g. `20260813T180000Z`)
 * used in the UNTIL clause. Returns null on any structural problem so
 * the caller can map to a typed failure.
 */
function parseUntilUtc(value: string): Date | null {
  // Strict regex: YYYYMMDDTHHMMSSZ, all digits, terminal Z.
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (match === null) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minRaw, secRaw] = match;
  const year = Number.parseInt(yearRaw ?? '0', 10);
  const month = Number.parseInt(monthRaw ?? '0', 10);
  const day = Number.parseInt(dayRaw ?? '0', 10);
  const hour = Number.parseInt(hourRaw ?? '0', 10);
  const min = Number.parseInt(minRaw ?? '0', 10);
  const sec = Number.parseInt(secRaw ?? '0', 10);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonthUtc(year, month - 1)) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;

  return new Date(Date.UTC(year, month - 1, day, hour, min, sec, 0));
}

/** Days in a month (UTC) — 0-indexed month (0 = January). */
function daysInMonthUtc(year: number, monthIndex: number): number {
  // Date.UTC(year, monthIndex + 1, 0) rolls back one day from the
  // first of the NEXT month, yielding the last day of monthIndex.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
