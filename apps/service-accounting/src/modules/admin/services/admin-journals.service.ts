import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local enum mirrors. Same TS-021-followup-2 / -3 root cause documented
 * across the codebase — Prisma 5.22's namespace value-side resolves
 * inconsistently under our tsconfig, so services hold locally-declared
 * string-literal unions for the generated enums. The cross-pin is the
 * contract-side `JournalKindSchema`.
 */
type JournalKindValue =
  | 'subscription_activation'
  | 'subscription_recognition'
  | 'subscription_cancellation'
  | 'booking_completion'
  | 'provider_payout'
  | 'refund'
  | 'coupon_redemption'
  | 'payment_processing_fee'
  | 'manual_adjustment'
  | 'period_close'
  | 'reversal';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Decimal-shaped value Prisma returns for `Decimal(...)` columns. We
 * narrow to the surface that matters at the persistence boundary —
 * `.toString()` — so the mapper can do integer-minor-unit conversion
 * exactly once on the way out. CLAUDE.md §17.6 forbids `Number` math
 * on money; we never do it here.
 */
interface DecimalLike {
  toString(): string;
}

export interface AdminJournalRow {
  readonly id: string;
  readonly kind: JournalKindValue;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly sourceEventId: string;
  readonly description: string;
  readonly periodId: string;
  readonly periodName: string;
  readonly postedByUserId: string | null;
  readonly reversedJournalId: string | null;
  readonly reversedByJournalId: string | null;
  readonly lines: readonly AdminJournalLineRow[];
  readonly context: unknown;
}

export interface AdminJournalLineRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly debit: DecimalLike;
  readonly credit: DecimalLike;
  readonly currency: string;
  readonly memo: string | null;
}

export interface AdminJournalListPage {
  readonly journals: readonly AdminJournalRow[];
  readonly nextCursor: string | null;
}

export interface ListJournalsInput {
  readonly periodId?: string | undefined;
  readonly periodName?: string | undefined;
  readonly kind?: JournalKindValue | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * Persisted Prisma row shape (hand-typed mirror — see the doc-comment
 * above the existing `journal.mapper.ts`). Lines are read in the
 * canonical posting order (`createdAt ASC`); the account relation is
 * eagerly selected for the denormalised `accountCode` / `accountName`.
 */
const JOURNAL_LIST_SELECT = {
  id: true,
  kind: true,
  occurredAt: true,
  postedAt: true,
  sourceEventId: true,
  description: true,
  periodId: true,
  period: { select: { id: true, name: true } },
  postedByUserId: true,
  reversedJournalId: true,
  reversedByJournalId: true,
  context: true,
  lines: {
    select: {
      id: true,
      accountId: true,
      debit: true,
      credit: true,
      currency: true,
      memo: true,
      account: { select: { code: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

interface PersistedJournalListRow {
  readonly id: string;
  readonly kind: JournalKindValue;
  readonly occurredAt: Date;
  readonly postedAt: Date;
  readonly sourceEventId: string;
  readonly description: string;
  readonly periodId: string;
  readonly period: { readonly id: string; readonly name: string };
  readonly postedByUserId: string | null;
  readonly reversedJournalId: string | null;
  readonly reversedByJournalId: string | null;
  readonly context: unknown;
  readonly lines: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly debit: DecimalLike;
    readonly credit: DecimalLike;
    readonly currency: string;
    readonly memo: string | null;
    readonly account: { readonly code: string; readonly name: string };
  }[];
}

/**
 * Admin journals read service (TS-129 Slice 1, closes TS-081-followup-7).
 *
 * Owns the read-only `GET /api/v1/admin/journals` cursor-paginated
 * browser + the `GET /api/v1/admin/journals/:id` detail surface. Both
 * endpoints are gated upstream by `AccessTokenGuard` +
 * `SuperAdminRoleGuard`; this service does NOT re-check authorisation.
 *
 * **Cursor pagination.** Opaque base64url-encoded `{occurredAt-ISO, id}`
 * pair. Server-side fixed ordering: `occurredAt DESC, id DESC` (most
 * recent first). Mirrors the TS-126 / TS-127 / TS-128 cursor codec so
 * admin tooling has one shape across surfaces — the only difference
 * here is the cursor anchor is `occurredAt` (the dated-as-of moment)
 * rather than `createdAt` (the persistence moment), because finance
 * staff care about the dated-as-of order on the journal browser.
 *
 * **Filter shape.** `periodId` / `periodName` are exact-match — when
 * both are provided, `periodId` wins (the unique id is more specific).
 * When only `periodName` is provided, the service resolves
 * `name → id` once before applying the where-clause; an unknown name
 * returns an empty page (not a 404 — list endpoints are forgiving).
 * `kind` is an exact-match against `journals.kind`.
 *
 * **Detail.** `getById` does a single `findUnique` with the lines
 * relation eagerly selected (same shape as the list). The lines are
 * already ordered by `createdAt ASC` in the select so the mapper
 * doesn't need to re-sort. Money math: the rows carry `Decimal` for
 * `debit` / `credit`; the mapper converts to integer minor units on
 * the way out.
 */
@Injectable()
export class AdminJournalsService {
  private readonly logger = new Logger(AdminJournalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(input: ListJournalsInput): Promise<AdminJournalListPage> {
    const limit = clampLimit(input.limit);
    const decoded = decodeCursor(input.cursor);

    const periodId = await this.resolvePeriodIdFilter(input.periodId, input.periodName);
    if (periodId === 'unknown') {
      // periodName supplied but no matching row — empty page (not 404).
      return { journals: [], nextCursor: null };
    }

    const where = {
      ...(periodId !== null ? { periodId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(decoded !== null
        ? {
            OR: [
              { occurredAt: { lt: decoded.occurredAt } },
              {
                AND: [{ occurredAt: decoded.occurredAt }, { id: { lt: decoded.id } }],
              },
            ],
          }
        : {}),
    };

    const rows = (await this.prisma.journal.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: JOURNAL_LIST_SELECT,
    })) as unknown as PersistedJournalListRow[];

    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor =
      hasMore && last !== undefined ? encodeCursor(last.occurredAt, last.id) : null;

    this.logger.log(
      {
        actorId: '<admin>',
        resultCount: trimmed.length,
        hasMore,
        filters: {
          periodId: input.periodId ?? null,
          periodName: input.periodName ?? null,
          kind: input.kind ?? null,
        },
      },
      'admin.journals.list',
    );

    return {
      journals: trimmed.map(toAdminJournalRow),
      nextCursor,
    };
  }

  async getById(journalId: string): Promise<AdminJournalRow | null> {
    const row = (await this.prisma.journal.findUnique({
      where: { id: journalId },
      select: JOURNAL_LIST_SELECT,
    })) as unknown as PersistedJournalListRow | null;
    if (row === null) return null;

    this.logger.log({ actorId: '<admin>', targetJournalId: row.id }, 'admin.journals.detail');

    return toAdminJournalRow(row);
  }

  /**
   * Resolve the periodId filter against the (periodId, periodName)
   * pair. Returns:
   *   - the supplied `periodId` (id wins when both are provided);
   *   - the looked-up id matching `periodName`;
   *   - the sentinel `'unknown'` when `periodName` was supplied but no
   *     row matches (caller turns this into an empty page);
   *   - `null` when no period scope was supplied at all.
   */
  private async resolvePeriodIdFilter(
    periodId: string | undefined,
    periodName: string | undefined,
  ): Promise<string | null | 'unknown'> {
    if (periodId !== undefined) return periodId;
    if (periodName === undefined) return null;
    const row = await this.prisma.accountingPeriod.findUnique({
      where: { name: periodName },
      select: { id: true },
    });
    if (row === null) return 'unknown';
    return row.id;
  }
}

function toAdminJournalRow(row: PersistedJournalListRow): AdminJournalRow {
  return {
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt,
    postedAt: row.postedAt,
    sourceEventId: row.sourceEventId,
    description: row.description,
    periodId: row.period.id,
    periodName: row.period.name,
    postedByUserId: row.postedByUserId,
    reversedJournalId: row.reversedJournalId,
    reversedByJournalId: row.reversedByJournalId,
    context: row.context,
    lines: row.lines.map((line) => ({
      id: line.id,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      debit: line.debit,
      credit: line.credit,
      currency: line.currency,
      memo: line.memo,
    })),
  };
}

function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT;
  if (requested > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(requested);
}

/**
 * Cursor codec: base64url of `${occurredAtIso}|${id}`. Mirrors the codec
 * in service-booking / service-subscription / service-identity admin
 * services so admin tooling has one shape across surfaces. The anchor
 * is `occurredAt` (the dated-as-of moment) rather than `createdAt`
 * because finance browsing orders journals by their accounting date.
 */
export function encodeCursor(occurredAt: Date, id: string): string {
  const payload = `${occurredAt.toISOString()}|${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { occurredAt: Date; id: string } | null {
  if (raw === undefined) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const pipe = decoded.indexOf('|');
    if (pipe < 0) return null;
    const iso = decoded.slice(0, pipe);
    const id = decoded.slice(pipe + 1);
    if (id.length === 0) return null;
    const occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}
