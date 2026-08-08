import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import type { BookingRecord } from './bookings.service';

export interface ListBookingsArgs {
  /** Authenticated actor — recorded for audit; row-level enforcement comes with TS-141. */
  readonly actorUserId: string;
  readonly householdId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
}

export interface ListBookingsResult {
  readonly rows: readonly BookingRecord[];
  readonly nextCursor: string | null;
}

/**
 * `BookingsListService` (TS-125).
 *
 * Read-side counterpart to `BookingsService`. Lists bookings for a
 * single household, newest-first, with opaque cursor pagination.
 *
 * **Scope.** Single-household only — there is no "all bookings across
 * all households I belong to" surface in Phase 1. The family-portal
 * UX has the user's primary household in scope (the multi-household
 * surface is captured by TS-125-followup-2 + the household-svc
 * resolver — same gap noted on TS-124-followup-1).
 *
 * **Row-level access.** Phase-1 enforcement is a thin marker logged at
 * debug — the controller layer authenticates the user; cross-household
 * membership checks land with TS-141 (Prisma extension) + the
 * household-svc resolver. The endpoint stays usable today and the gate
 * can be tightened without a contract change.
 *
 * **Cursor shape.** `base64url(createdAtIso|id)`. Stable under writes:
 * a new row inserted at the cursor boundary cannot leak into a prior
 * page because the strict `(createdAt < cursor.createdAt) OR
 * (createdAt = cursor.createdAt AND id < cursor.id)` predicate covers
 * the tie-break. Mirrors the mature pattern in
 * `service-media/assets.service.ts`.
 */
@Injectable()
export class BookingsListService {
  private readonly logger = new Logger(BookingsListService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listByHousehold(args: ListBookingsArgs): Promise<ListBookingsResult> {
    const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor);
    const rows = (await this.prisma.booking.findMany({
      where: {
        householdId: args.householdId,
        ...(cursor !== null && {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            {
              AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }],
            },
          ],
        }),
      },
      take: args.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) as BookingRecord[];

    const sliced = rows.slice(0, args.limit);
    const overflow = rows.length > args.limit ? rows[args.limit] : null;
    const nextCursor =
      overflow === null || overflow === undefined
        ? null
        : encodeCursor({ createdAt: overflow.createdAt, id: overflow.id });
    this.logger.debug(
      `bookings.list householdId=${args.householdId} actorUserId=${args.actorUserId} returned=${sliced.length} hasMore=${nextCursor !== null}`,
    );
    return { rows: sliced, nextCursor };
  }
}

interface DecodedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|', 2);
    if (iso === undefined || id === undefined) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
