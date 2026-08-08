import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

type PeriodLifecycleKindValue = 'close' | 'reopen';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface AdminPeriodEventRow {
  readonly id: string;
  readonly periodId: string;
  readonly periodName: string;
  readonly kind: PeriodLifecycleKindValue;
  readonly actorUserId: string;
  readonly sourceEventId: string;
  readonly reasonCode: string;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface AdminPeriodEventListPage {
  readonly events: readonly AdminPeriodEventRow[];
  readonly nextCursor: string | null;
}

export interface ListPeriodEventsInput {
  readonly periodName: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export type ListPeriodEventsResult =
  | { readonly kind: 'ok'; readonly page: AdminPeriodEventListPage }
  | { readonly kind: 'period_not_found'; readonly periodName: string };

/**
 * Admin per-period lifecycle audit (TS-129 Slice 1, closes
 * TS-085-followup-7).
 *
 * Owns the read-only `GET /api/v1/admin/periods/:periodName/events`
 * surface. Resolves the period name to the period row first — a
 * non-existent period name surfaces as a 404 (unlike the journal-list
 * + trial-balance flow which treats unknown period as "empty page",
 * because the route path is explicit about the targeted period and
 * the user-facing error is more accurate). Cursor-paginated on
 * `(occurredAt DESC, id DESC)` — newest transitions first.
 *
 * The `period_lifecycle_events_period_idx` index supports this exact
 * read pattern (defined in the TS-085 migration; see the schema-side
 * doc-comment on `PeriodLifecycleEvent`).
 */
@Injectable()
export class AdminPeriodEventsService {
  private readonly logger = new Logger(AdminPeriodEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listByPeriod(input: ListPeriodEventsInput): Promise<ListPeriodEventsResult> {
    const limit = clampLimit(input.limit);
    const decoded = decodeCursor(input.cursor);

    const period = await this.prisma.accountingPeriod.findUnique({
      where: { name: input.periodName },
      select: { id: true, name: true },
    });
    if (period === null) {
      return { kind: 'period_not_found', periodName: input.periodName };
    }

    const where = {
      periodId: period.id,
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

    const rows = (await this.prisma.periodLifecycleEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        periodId: true,
        kind: true,
        actorUserId: true,
        sourceEventId: true,
        reasonCode: true,
        description: true,
        occurredAt: true,
        createdAt: true,
      },
    })) as readonly {
      readonly id: string;
      readonly periodId: string;
      readonly kind: PeriodLifecycleKindValue;
      readonly actorUserId: string;
      readonly sourceEventId: string;
      readonly reasonCode: string;
      readonly description: string | null;
      readonly occurredAt: Date;
      readonly createdAt: Date;
    }[];

    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor =
      hasMore && last !== undefined ? encodeCursor(last.occurredAt, last.id) : null;

    this.logger.log(
      {
        actorId: '<admin>',
        periodName: period.name,
        resultCount: trimmed.length,
        hasMore,
      },
      'admin.periods.events.list',
    );

    const events: AdminPeriodEventRow[] = trimmed.map((row) => ({
      id: row.id,
      periodId: row.periodId,
      periodName: period.name,
      kind: row.kind,
      actorUserId: row.actorUserId,
      sourceEventId: row.sourceEventId,
      reasonCode: row.reasonCode,
      description: row.description,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
    }));

    return { kind: 'ok', page: { events, nextCursor } };
  }
}

function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT;
  if (requested > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(requested);
}

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
