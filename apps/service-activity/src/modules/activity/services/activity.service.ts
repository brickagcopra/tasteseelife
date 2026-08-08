import { Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../../../prisma/generated';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Activity-event persistence (TS-101). Orchestrates the two Phase-1
 * surfaces:
 *
 *   1. **Record an event** — `recordEvent()` ingests a producer-
 *      assigned activity event and INSERTs. Idempotent on `eventId` —
 *      a retried submission replays into the existing row.
 *
 *   2. **List by user** — `listByUser()` returns events for a single
 *      `userId`, ordered most-recent first, cursor-paginated. Powers
 *      both the user-facing self-view and the admin search; the
 *      controller layer decides which user-id flows in (self =
 *      authenticated actor's id; admin = path param).
 *
 * **Idempotency.** The flow is "SELECT existing by eventId → if hit,
 * return; else INSERT". The dedup key is the producer-supplied
 * `eventId` (UNIQUE on the column). A unique-constraint race (two
 * callers POST the same eventId at the exact same time, both pass the
 * findUnique check without yet seeing the other's row) is handled by
 * catching Prisma's P2002 and re-reading the now-persisted row.
 *
 * **No hash chain, no advisory lock.** Unlike service-audit, the
 * activity stream is user-visible (PRD §6.1) and serves the user's
 * self-service review, not tamper-evident ops auditing. No chain
 * means no per-resource serialisation requirement → simpler write
 * path. The audit-svc owns the chained admin mutation log.
 *
 * **No mutation surface.** The service exposes `recordEvent()` and
 * `listByUser()`. There is no `update` / `delete` — the append-only
 * invariant (CLAUDE.md §17.7, applied defensively) is enforced both
 * here and at the database-trigger layer.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist an activity event.
   *
   * Returns `{ outcome: 'recorded', event }` on a fresh insert and
   * `{ outcome: 'replayed', event }` when the producer's eventId is
   * already on file. Replay returns the existing row unchanged — the
   * producer's retry never accidentally overwrites the stream.
   */
  async recordEvent(input: RecordEventInput): Promise<RecordEventResult> {
    const existing = await this.prisma.activityEvent.findUnique({
      where: { eventId: input.eventId },
    });
    if (existing !== null) {
      return { outcome: 'replayed', event: rowToEvent(existing) };
    }

    try {
      const inserted = await this.prisma.activityEvent.create({
        data: {
          eventId: input.eventId,
          userId: input.userId,
          kind: input.kind,
          occurredAt: input.occurredAt,
          ip: input.ip,
          userAgent: input.userAgent,
          deviceFingerprint: input.deviceFingerprint,
          requestId: input.requestId,
          traceId: input.traceId,
          // `metadata` is `Json?`. Prisma distinguishes SQL NULL from JSON
          // `null` on nullable Json columns, so a bare `null` is NOT a legal
          // input — it must be `Prisma.DbNull` (SQL NULL, which is what an
          // absent adjunct payload means here). Passing `null` type-checked
          // only against the pre-TS-500 client stub; against the real client
          // it is rejected, and at runtime it raised a Prisma validation
          // error on every metadata-less event.
          metadata:
            input.metadata === undefined || input.metadata === null
              ? Prisma.DbNull
              : (input.metadata as Prisma.InputJsonValue),
        },
      });
      return { outcome: 'recorded', event: rowToEvent(inserted) };
    } catch (err) {
      // P2002 — concurrent insert of the same eventId between the
      // findUnique read and our create. Read the now-persisted row
      // and return it as a replay.
      if (isPrismaUniqueViolation(err)) {
        const winnerRow = await this.prisma.activityEvent.findUnique({
          where: { eventId: input.eventId },
        });
        if (winnerRow !== null) {
          this.logger.debug({ eventId: input.eventId }, 'activity.recordEvent.race_won_by_peer');
          return { outcome: 'replayed', event: rowToEvent(winnerRow) };
        }
      }
      throw err;
    }
  }

  /**
   * Cursor-paginated read by `userId`. Returns events newest-first;
   * `nextCursor` is null when the caller has reached the end of the
   * result set.
   *
   * The optional `kindFilter` narrows to a single categorical kind.
   * The cursor decodes to `(occurredAt, id)` so pagination is stable
   * even when multiple events share the same `occurredAt`.
   */
  async listByUser(query: ListByUserQuery): Promise<ListResult> {
    const limit = query.limit;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.activityEvent.findMany({
      where: {
        userId: query.userId,
        ...(query.kindFilter !== undefined && { kind: query.kindFilter }),
        ...(decoded !== null && {
          OR: [
            { occurredAt: { lt: decoded.occurredAt } },
            {
              occurredAt: { equals: decoded.occurredAt },
              id: { lt: decoded.id },
            },
          ],
        }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // peek for the cursor
    });

    return buildListResult(rows, limit);
  }
}

// ─── Domain types ───────────────────────────────────────────────────────

/**
 * Categorical activity event kind. Mirrors the wire-layer enum from
 * `@taste-and-see/contracts` — kept as a local string-union here to
 * avoid an inbound dependency on the contracts package's enum tuple
 * at the service-internal boundary. The contract layer's
 * `ActivityEventKindSchema` is the source of truth at the HTTP
 * boundary; the controller forwards the validated value to the
 * service.
 */
export type ActivityEventKind =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'password_changed'
  | 'mfa_enrolled'
  | 'mfa_removed'
  | 'profile_changed'
  | 'payment_method_added'
  | 'payment_method_removed'
  | 'subscription_changed'
  | 'booking_created'
  | 'booking_canceled'
  | 'role_granted'
  | 'role_revoked'
  | 'suspicious_activity_flag';

export interface RecordEventInput {
  readonly eventId: string;
  readonly userId: string;
  readonly kind: ActivityEventKind;
  readonly occurredAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceFingerprint: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly metadata: unknown;
}

export type RecordEventOutcome = 'recorded' | 'replayed';

export interface ActivityEvent {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly kind: ActivityEventKind;
  readonly occurredAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceFingerprint: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

export interface RecordEventResult {
  readonly outcome: RecordEventOutcome;
  readonly event: ActivityEvent;
}

export interface ListByUserQuery {
  readonly userId: string;
  readonly kindFilter?: ActivityEventKind | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ListResult {
  readonly events: readonly ActivityEvent[];
  readonly nextCursor: string | null;
}

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Build the result wrapper for a list endpoint. The query asked for
 * `limit + 1` rows; if the result set is larger than `limit`, the
 * last row provides the next cursor.
 */
function buildListResult(rows: readonly PrismaActivityEventRow[], limit: number): ListResult {
  if (rows.length <= limit) {
    return {
      events: rows.map(rowToEvent),
      nextCursor: null,
    };
  }
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  if (last === undefined) {
    // Defensive — only possible if limit was zero, which the schema
    // forbids (`positive()`).
    return { events: [], nextCursor: null };
  }
  return {
    events: slice.map(rowToEvent),
    nextCursor: encodeCursor(last.occurredAt, last.id),
  };
}

/**
 * Cursor shape: `(occurredAt ISO, surrogate id)`. Base64-encoded JSON
 * keeps the shape opaque on the wire — clients should treat the
 * string as an opaque token and pass it back unchanged.
 */
interface DecodedCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

function encodeCursor(occurredAt: Date, id: string): string {
  const payload = JSON.stringify({
    occurredAt: occurredAt.toISOString(),
    id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>)['occurredAt'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string'
    ) {
      return null;
    }
    const occurredAtRaw = (parsed as Record<string, unknown>)['occurredAt'] as string;
    const idRaw = (parsed as Record<string, unknown>)['id'] as string;
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id: idRaw };
  } catch {
    return null;
  }
}

/**
 * Local mirror of the Prisma row shape. The `kind` column is the
 * generated enum type from `@prisma/client`, but the namespace value-
 * side resolution issue documented in TS-021-followup-2 / TS-100-followup-8
 * means we mirror the type locally and rely on the contract enum to
 * keep both sides in step. The string-union shape matches the Prisma
 * enum exactly; drift would surface at the type-check boundary on the
 * `create({ data: { kind } })` call.
 *
 * TS-101-followup captures the cleanup: replace this with
 * `import type { ActivityEvent } from '@prisma/client'` once Prisma 5.23
 * / 6.x lands and the namespace resolves cleanly.
 */
type PrismaActivityEventRow = {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly kind: ActivityEventKind;
  readonly occurredAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceFingerprint: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
};

function rowToEvent(row: PrismaActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    kind: row.kind,
    occurredAt: row.occurredAt,
    ip: row.ip,
    userAgent: row.userAgent,
    deviceFingerprint: row.deviceFingerprint,
    requestId: row.requestId,
    traceId: row.traceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

/**
 * Duck-typed narrowing for Prisma's P2002 unique-constraint failure.
 *
 * Tracks the same TS-021-followup-2 root cause documented across the
 * codebase — Prisma 5.22's namespace value-side resolves inconsistently
 * under our `verbatimModuleSyntax: false` / `isolatedModules: true`
 * tsconfig. The duck-typed guard is the established workaround;
 * TS-101-followup captures the cleanup once 5.23 / 6.x lands.
 */
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
