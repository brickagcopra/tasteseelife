import type { BookingSubjectHoldKind } from '../../subject-hold-kinds';

/** In-memory `booking_subject_holds` row. */
export interface FakeHoldRow {
  id: string;
  incidentId: string;
  subjectKind: BookingSubjectHoldKind;
  subjectId: string;
  severity: string;
  category: string;
  heldAt: Date;
  releasedAt: Date | null;
  sourceEventId: string;
  releaseEventId: string | null;
}

/** In-memory `bookings` row — only the columns the hold paths touch. */
export interface FakeBookingRow {
  id: string;
  householdId: string;
  seniorId: string;
  providerId: string;
  status: string;
  heldByIncidentId: string | null;
  heldAt: Date | null;
}

/**
 * Purpose-built Prisma fake for `SubjectHoldsService` (TS-304).
 *
 * **Deliberately query-specific, not a general Prisma emulator.** It
 * implements exactly the filter shapes the service issues — `OR` over
 * `(subjectKind, subjectId)` pairs, `subjectId: { in: [...] }`,
 * `status: { in: [...] }`, `id: { in: [...] }`, `releasedAt: null`,
 * `heldByIncidentId: null` — and throws on anything else rather than
 * silently matching everything. A fake that quietly ignores an unrecognised
 * predicate turns "the hold matched nothing" into a green test, which on
 * this surface means a provider under a critical concern keeps visiting.
 *
 * `$transaction` deep-copies before running the callback and restores on
 * throw, so a rolled-back mutation is genuinely rolled back — including
 * in-place UPDATEs, which a shallow `[...rows]` snapshot would leak (the
 * fixture bug found in `service-trust-safety` under TS-303b).
 */
export class FakeHoldsPrisma {
  holds: FakeHoldRow[] = [];
  bookings: FakeBookingRow[] = [];
  private seq = 0;

  readonly booking = {
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>> => {
      const matched = this.bookings.filter((row) => matchBooking(row, args.where));
      return matched.map((row) => project(row as unknown as Record<string, unknown>, args.select));
    },

    updateMany: async (args: {
      where: Record<string, unknown>;
      data: { heldByIncidentId: string | null; heldAt: Date | null };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.bookings) {
        if (!matchBooking(row, args.where)) continue;
        row.heldByIncidentId = args.data.heldByIncidentId;
        row.heldAt = args.data.heldAt;
        count += 1;
      }
      return { count };
    },
  };

  readonly bookingSubjectHold = {
    createMany: async (args: {
      data: Array<{
        incidentId: string;
        subjectKind: BookingSubjectHoldKind;
        subjectId: string;
        severity: string;
        category: string;
        heldAt: Date;
        sourceEventId: string;
      }>;
      skipDuplicates?: boolean;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of args.data) {
        // Both real UNIQUEs: (sourceEventId, subjectKind) and
        // (incidentId, subjectKind, subjectId).
        const duplicate = this.holds.some(
          (existing) =>
            (existing.sourceEventId === row.sourceEventId &&
              existing.subjectKind === row.subjectKind) ||
            (existing.incidentId === row.incidentId &&
              existing.subjectKind === row.subjectKind &&
              existing.subjectId === row.subjectId),
        );
        if (duplicate) {
          if (args.skipDuplicates === true) continue;
          throw new Error('unique constraint violation on booking_subject_holds');
        }
        this.seq += 1;
        this.holds.push({
          id: `hold_${this.seq}`,
          releasedAt: null,
          releaseEventId: null,
          ...row,
        });
        count += 1;
      }
      return { count };
    },

    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: unknown;
    }): Promise<Array<Record<string, unknown>>> => {
      const matched = this.holds.filter((row) => matchHold(row, args.where));
      // The service orders by (heldAt asc, incidentId asc) in both reads;
      // the fake applies that ordering unconditionally because both call
      // sites depend on "oldest hold first" for their result.
      matched.sort(
        (a, b) =>
          a.heldAt.getTime() - b.heldAt.getTime() || a.incidentId.localeCompare(b.incidentId),
      );
      return matched.map((row) => project(row as unknown as Record<string, unknown>, args.select));
    },

    updateMany: async (args: {
      where: Record<string, unknown>;
      data: { releasedAt: Date; releaseEventId: string };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.holds) {
        if (!matchHold(row, args.where)) continue;
        row.releasedAt = args.data.releasedAt;
        row.releaseEventId = args.data.releaseEventId;
        count += 1;
      }
      return { count };
    },
  };

  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const holdSnapshot = this.holds.map((row) => ({ ...row }));
    const bookingSnapshot = this.bookings.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (error) {
      this.holds = holdSnapshot;
      this.bookings = bookingSnapshot;
      throw error;
    }
  }
}

const HOLD_KEYS = new Set([
  'incidentId',
  'subjectKind',
  'subjectId',
  'releasedAt',
  'sourceEventId',
  'OR',
]);
const BOOKING_KEYS = new Set([
  'id',
  'heldByIncidentId',
  'status',
  'OR',
  'providerId',
  'seniorId',
  'householdId',
]);

function matchHold(row: FakeHoldRow, where: Record<string, unknown>): boolean {
  assertKnownKeys(where, HOLD_KEYS, 'bookingSubjectHold');
  return matchGeneric(
    row as unknown as Record<string, unknown>,
    where,
    HOLD_KEYS,
    'bookingSubjectHold',
  );
}

function matchBooking(row: FakeBookingRow, where: Record<string, unknown>): boolean {
  assertKnownKeys(where, BOOKING_KEYS, 'booking');
  return matchGeneric(row as unknown as Record<string, unknown>, where, BOOKING_KEYS, 'booking');
}

function matchGeneric(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
  known: ReadonlySet<string>,
  model: string,
): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchGeneric(row, clause, known, model))) return false;
      continue;
    }
    if (!matchField(row[key], condition)) return false;
  }
  return true;
}

function matchField(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (
    typeof condition === 'object' &&
    condition !== null &&
    'in' in (condition as Record<string, unknown>)
  ) {
    const list = (condition as { in: readonly unknown[] }).in;
    return list.includes(value);
  }
  return value === condition;
}

function assertKnownKeys(
  where: Record<string, unknown>,
  known: ReadonlySet<string>,
  model: string,
): void {
  for (const key of Object.keys(where)) {
    if (!known.has(key)) {
      // Loud on purpose — see the class doc. An unrecognised predicate must
      // never degrade to "matches everything".
      throw new Error(
        `FakeHoldsPrisma(${model}): unsupported where key '${key}' — extend the fixture rather than letting it match everything`,
      );
    }
  }
}

function project(
  row: Record<string, unknown>,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  if (select === undefined) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}
