import type { JournalResponse, JournalLineResponse } from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

/**
 * The Prisma row shape consumed by `toJournalResponse`. Hand-typed
 * mirror of the `JOURNAL_WITH_LINES_SELECT` projection in
 * `journal-posting.service.ts`. The TS-021-followup-2 / TS-080-
 * followup-3 cleanup will replace this with the generated
 * `Prisma.JournalGetPayload<...>` shape once the namespace value-
 * side resolves cleanly.
 *
 * `debit` / `credit` arrive from Prisma as `Decimal` — they're
 * Prisma's own `Decimal` runtime, which is interface-compatible
 * with `decimal.js` for the operations we need (`toFixed`, `mul`,
 * `eq`). We treat them as `unknown` here and narrow via
 * `toDecimal()` to avoid coupling to Prisma's internal
 * `Decimal` re-export.
 */
export interface PersistedJournalWithLines {
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly sourceEventId: string;
  readonly description: string;
  readonly periodId: string;
  readonly period: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  };
  readonly postedByUserId: string | null;
  readonly reversedJournalId: string | null;
  readonly reversedByJournalId: string | null;
  readonly context: unknown;
  readonly lines: readonly PersistedJournalLine[];
}

export interface PersistedJournalLine {
  readonly id: string;
  readonly accountId: string;
  readonly debit: unknown;
  readonly credit: unknown;
  readonly currency: string;
  readonly memo: string | null;
  readonly account: { readonly code: string };
}

/**
 * Translate a persisted journal + lines into the public DTO.
 *
 * - `occurredAt` / `postedAt` → ISO-8601 strings.
 * - `debit` / `credit` Decimals → integer minor units on the wire.
 * - `currency` narrowed to the contract enum (USD only in Phase 1
 *   — a future-currency row surfaces a clean 500 rather than
 *   silently passing through unsupported wire shape, mirroring
 *   the chart-of-accounts mapper).
 * - `context` is `unknown` from Prisma's `jsonb`; the contract
 *   accepts `Record<string, unknown>` so we cast through `object`.
 */
export function toJournalResponse(row: PersistedJournalWithLines): JournalResponse {
  return {
    id: row.id,
    kind: row.kind as JournalResponse['kind'],
    occurredAt: row.occurredAt.toISOString(),
    postedAt: row.postedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    description: row.description,
    periodId: row.period.id,
    periodName: row.period.name,
    postedByUserId: row.postedByUserId,
    reversedJournalId: row.reversedJournalId,
    reversedByJournalId: row.reversedByJournalId,
    context: normalizeContext(row.context),
    lines: row.lines.map(toLineResponse),
  };
}

function toLineResponse(line: PersistedJournalLine): JournalLineResponse {
  return {
    id: line.id,
    accountId: line.accountId,
    accountCode: line.account.code,
    debitMinor: decimalToMinor(line.debit),
    creditMinor: decimalToMinor(line.credit),
    currency: narrowCurrency(line.currency),
    ...(line.memo !== null && { memo: line.memo }),
  };
}

function decimalToMinor(value: unknown): number {
  const decimal = toDecimal(value);
  return Number(decimal.mul(100).toFixed(0));
}

function toDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  // Prisma's own `Decimal` runtime supports `.toString()` to
  // produce a canonical decimal string. `decimal.js` accepts the
  // same representation.
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(
    `journal mapper: unexpected non-Decimal value on amount column: ${String(value)}`,
  );
}

function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`unsupported currency in journal line: ${value}`);
  }
  return 'USD';
}

function normalizeContext(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') {
    throw new Error(`journal mapper: expected context to be a JSON object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}
