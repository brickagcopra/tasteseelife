import { Injectable, Logger } from '@nestjs/common';

import { Prisma } from '../../../../prisma/generated';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { HashChainService, type ChainInput } from './hash-chain.service';

/**
 * Audit-event persistence (TS-100). Orchestrates the three Phase-1
 * surfaces:
 *
 *   1. **Record an event** — `recordEvent()` ingests a producer-
 *      assigned audit event, computes the per-resource chain hash,
 *      and INSERTs. Idempotent on `eventId` — a retried submission
 *      replays into the existing row.
 *
 *   2. **List by resource** — `listByResource()` returns events for a
 *      `(resourceKind, resourceId)` partition, ordered most-recent
 *      first, cursor-paginated.
 *
 *   3. **List by actor** — `listByActor()` returns events authored by
 *      a single user-id, ordered most-recent first, cursor-paginated.
 *
 * **Hash chain concurrency.** Two concurrent writers for the same
 * `(resourceKind, resourceId)` would otherwise both read the same
 * "previous chain hash" and produce a fork. The fix is a per-resource
 * Postgres advisory lock acquired inside the same transaction as the
 * read + insert: the lock serializes writes-per-resource (cheap, since
 * a typical resource sees handful of mutations per day) without
 * blocking writes across resources. The lock is transaction-scoped
 * (`pg_advisory_xact_lock`) — released automatically on COMMIT or
 * ROLLBACK.
 *
 * **Idempotency.** The flow is "advisory lock → SELECT existing by
 * eventId → if hit, return; else compute chain → INSERT". The dedup
 * key is the producer-supplied `eventId` (UNIQUE on the column). A
 * unique-constraint race (two callers POST the same eventId at the
 * exact same time, both pass the advisory lock without yet seeing the
 * other's row) is handled by catching Prisma's P2002 and re-reading
 * the now-persisted row.
 *
 * **No mutation surface.** The service exposes `recordEvent()` and
 * the two `list*` methods. There is no `update` / `delete` — the
 * append-only invariant (CLAUDE.md §17.7) is enforced both here and
 * at the database-trigger layer.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashChain: HashChainService,
  ) {}

  /**
   * Persist an audit event with a per-resource SHA-256 chain hash.
   *
   * Returns `{ outcome: 'recorded', event }` on a fresh insert and
   * `{ outcome: 'replayed', event }` when the producer's eventId is
   * already on file. Replay returns the existing row unchanged — the
   * producer's retry never accidentally overwrites the chain.
   */
  async recordEvent(input: RecordEventInput): Promise<RecordEventResult> {
    const existing = await this.prisma.auditEvent.findUnique({
      where: { eventId: input.eventId },
    });
    if (existing !== null) {
      return { outcome: 'replayed', event: rowToEvent(existing) };
    }

    // Single transaction: acquire the per-resource advisory lock, read
    // the chain head, compute the new chain hash, INSERT. The lock is
    // released on COMMIT.
    const row = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const lockKey = chainLockKey(input.resourceKind, input.resourceId);
      // `pg_advisory_xact_lock(bigint)` takes a signed 64-bit integer
      // — we feed it a hash derived from `(resourceKind, resourceId)`.
      // Using two 32-bit halves (`hashtext(...)` returns int4) keeps
      // us inside the bigint range without arithmetic.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        lockKey.kindKey,
        lockKey.idKey,
      );

      // Re-check inside the lock: a concurrent writer may have inserted
      // OUR eventId between the outer findUnique and the lock
      // acquisition (only possible if the same producer retried in
      // the narrow window — but the dedup-replay path is the right
      // shape for that case).
      const recheckExisting = await tx.auditEvent.findUnique({
        where: { eventId: input.eventId },
      });
      if (recheckExisting !== null) {
        return { row: recheckExisting, replayed: true };
      }

      // Read the chain head for this resource.
      const prev = await tx.auditEvent.findFirst({
        where: {
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
        },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { chainHash: true },
      });

      const chainPrevHash = prev !== null ? prev.chainHash : null;

      const chainInput: ChainInput = {
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        actorTenantScopeType: input.actorTenantScopeType,
        actorTenantScopeId: input.actorTenantScopeId,
        action: input.action,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        beforeJson: input.beforeJson,
        afterJson: input.afterJson,
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: input.requestId,
        traceId: input.traceId,
        chainPrevHash,
      };
      const chainHash = this.hashChain.compute(chainInput);

      try {
        const inserted = await tx.auditEvent.create({
          data: {
            eventId: input.eventId,
            occurredAt: input.occurredAt,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            actorTenantScopeType: input.actorTenantScopeType,
            actorTenantScopeId: input.actorTenantScopeId,
            action: input.action,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            // `beforeJson` / `afterJson` are `Json?`. On a nullable Json
            // column Prisma separates SQL NULL (`Prisma.DbNull`) from JSON
            // `null` (`Prisma.JsonNull`), so a bare `null` is not a legal
            // input — "no prior state" / "no resulting state" is SQL NULL.
            // The bare `null` only ever type-checked against the pre-TS-500
            // client stub; against the real client it is rejected.
            beforeJson:
              input.beforeJson === undefined
                ? Prisma.DbNull
                : (input.beforeJson as Prisma.InputJsonValue),
            afterJson:
              input.afterJson === undefined
                ? Prisma.DbNull
                : (input.afterJson as Prisma.InputJsonValue),
            ip: input.ip,
            userAgent: input.userAgent,
            requestId: input.requestId,
            traceId: input.traceId,
            chainPrevHash,
            chainHash,
          },
        });
        return { row: inserted, replayed: false };
      } catch (err) {
        // P2002 — concurrent insert of the same eventId between the
        // recheck and our create. Read the now-persisted row and
        // return it as a replay.
        if (isPrismaUniqueViolation(err)) {
          const winnerRow = await tx.auditEvent.findUnique({
            where: { eventId: input.eventId },
          });
          if (winnerRow !== null) {
            this.logger.debug({ eventId: input.eventId }, 'audit.recordEvent.race_won_by_peer');
            return { row: winnerRow, replayed: true };
          }
        }
        throw err;
      }
    });

    return {
      outcome: row.replayed ? 'replayed' : 'recorded',
      event: rowToEvent(row.row),
    };
  }

  /**
   * Cursor-paginated read by `(resourceKind, resourceId)`. Returns
   * events newest-first; `nextCursor` is null when the caller has
   * reached the end of the result set.
   */
  async listByResource(query: ListByResourceQuery): Promise<ListResult> {
    const limit = query.limit;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        resourceKind: query.resourceKind,
        resourceId: query.resourceId,
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

  /**
   * KIND-WIDE cursor-paginated read (TS-295): every event whose
   * `resourceKind` is in `resourceKinds` (≤5, pre-split by the caller
   * from the contract's CSV), optionally filtered by exact `action`
   * and/or `actorUserId`, ordered by `(occurredAt, id)` in the
   * requested direction. Backed by `audit_events_kind_occurred_idx` —
   * one ordered run per kind, merge-appended (see the migration
   * comment). The dominant caller is the RBAC History view listing
   * `rbac_role` + `rbac_assignment` + `rbac_approval` in one stream.
   */
  async listByResourceKinds(query: ListByResourceKindsQuery): Promise<ListResult> {
    const limit = query.limit;
    const direction = query.order;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    // Direction-aware keyset filter, spelled out per branch — a computed
    // `[cmp]:` key would loosen the filter type under this tsconfig.
    const cursorFilter =
      decoded === null
        ? {}
        : direction === 'desc'
          ? {
              OR: [
                { occurredAt: { lt: decoded.occurredAt } },
                { occurredAt: { equals: decoded.occurredAt }, id: { lt: decoded.id } },
              ],
            }
          : {
              OR: [
                { occurredAt: { gt: decoded.occurredAt } },
                { occurredAt: { equals: decoded.occurredAt }, id: { gt: decoded.id } },
              ],
            };

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        resourceKind: { in: [...query.resourceKinds] },
        ...(query.action !== undefined && { action: query.action }),
        ...(query.actorUserId !== undefined && { actorUserId: query.actorUserId }),
        ...cursorFilter,
      },
      orderBy: [{ occurredAt: direction }, { id: direction }],
      take: limit + 1, // peek for the cursor
    });

    return buildListResult(rows, limit);
  }

  /**
   * Cursor-paginated read by `actorUserId`. Returns events newest-first;
   * `nextCursor` is null when the caller has reached the end.
   *
   * System events (where `actorUserId IS NULL`) are excluded — the
   * per-admin search has no use for them and the partial index
   * `audit_events_actor_occurred_idx` is built `WHERE actor_user_id IS
   * NOT NULL` to match.
   */
  async listByActor(query: ListByActorQuery): Promise<ListResult> {
    const limit = query.limit;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.auditEvent.findMany({
      where: {
        actorUserId: query.actorUserId,
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
      take: limit + 1,
    });

    return buildListResult(rows, limit);
  }
}

// ─── Domain types ───────────────────────────────────────────────────────

export interface RecordEventInput {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly actorTenantScopeType: 'global' | 'tenant' | 'household' | 'system';
  readonly actorTenantScopeId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly beforeJson: unknown;
  readonly afterJson: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

export type RecordEventOutcome = 'recorded' | 'replayed';

export interface AuditEvent {
  readonly id: string;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly actorTenantScopeType: 'global' | 'tenant' | 'household' | 'system';
  readonly actorTenantScopeId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly beforeJson: unknown;
  readonly afterJson: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly chainPrevHash: string | null;
  readonly chainHash: string;
  readonly createdAt: Date;
}

export interface RecordEventResult {
  readonly outcome: RecordEventOutcome;
  readonly event: AuditEvent;
}

export interface ListByResourceQuery {
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ListByActorQuery {
  readonly actorUserId: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ListByResourceKindsQuery {
  /** Pre-split, de-duplicated kinds (≤ contract cap). */
  readonly resourceKinds: readonly string[];
  /** Exact action-string filter (e.g. `rbac_role:updated`). */
  readonly action?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly order: 'desc' | 'asc';
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface ListResult {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Build the result wrapper for a list endpoint. The query asked for
 * `limit + 1` rows; if the result set is larger than `limit`, the
 * last row provides the next cursor.
 */
function buildListResult(rows: readonly PrismaAuditEventRow[], limit: number): ListResult {
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
 * Advisory-lock key pair derived from `(resourceKind, resourceId)`.
 * The two halves feed `pg_advisory_xact_lock(int, int)` so a SHA-256
 * collision on the concatenated string would be required to false-
 * share two unrelated resources' locks — wildly improbable, and the
 * worst case is a false serialization, not data loss.
 */
interface AdvisoryLockKey {
  readonly kindKey: string;
  readonly idKey: string;
}

function chainLockKey(resourceKind: string, resourceId: string): AdvisoryLockKey {
  return {
    kindKey: `audit-chain:${resourceKind}`,
    idKey: resourceId,
  };
}

/**
 * Project a Prisma row to the AuditEvent domain shape. The two JSON
 * columns come back as Prisma's `JsonValue`; we expose them as
 * `unknown` so downstream layers narrow per-call.
 */
type PrismaAuditEventRow = {
  readonly id: string;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly actorTenantScopeType: 'global' | 'tenant' | 'household' | 'system';
  readonly actorTenantScopeId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly beforeJson: unknown;
  readonly afterJson: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly chainPrevHash: string | null;
  readonly chainHash: string;
  readonly createdAt: Date;
};

function rowToEvent(row: PrismaAuditEventRow): AuditEvent {
  return {
    id: row.id,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    actorTenantScopeType: row.actorTenantScopeType,
    actorTenantScopeId: row.actorTenantScopeId,
    action: row.action,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    traceId: row.traceId,
    chainPrevHash: row.chainPrevHash,
    chainHash: row.chainHash,
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
 * TS-100-followup captures the cleanup once 5.23 / 6.x lands.
 */
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
