import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import { RbacExpiryEmitter } from './rbac-expiry-emitter';
import { AuditEmitter, SYSTEM_AUDIT_ACTOR } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

/** Scope type as stored on `identity.user_roles.scope_type`. */
type DbScopeType = 'global' | 'tenant' | 'household';

/** The row slice the sweep selects — everything the event + audit line need. */
interface ExpiredRow {
  readonly id: string;
  readonly userId: string;
  readonly scopeType: DbScopeType;
  readonly scopeId: string | null;
  readonly expiresAt: Date | null;
  readonly role: { readonly name: string };
}

export interface ExpireSweepResult {
  /** Rows durably revoked across all batches this sweep. */
  readonly revokedCount: number;
  /** Transaction batches executed (0 when nothing was expired). */
  readonly batchCount: number;
}

/** Default max rows per transaction batch — see `RBAC_REVOKER_BATCH_SIZE`. */
export const EXPIRE_SWEEP_DEFAULT_BATCH_SIZE = 500;

/**
 * The rbac-revoker's domain half (TS-293; CLAUDE.md §3.2 "role assignments
 * support expiration"): durably revoke every `user_roles` row whose
 * `expires_at` has passed but whose `revoked_at` is still null.
 *
 * Expiry is ALREADY enforced at read time — `getActiveAssignments` /
 * `holdsAnyRole` filter on `expires_at`, so an expired grant never reaches
 * a token regardless of this sweep. The sweep makes expiry *durable and
 * observable*: the row flips to revoked (so admin surfaces and history
 * agree), the revocation is audit-logged, and the holder is notified via
 * `identity.role_assignment.expired` (the outbox event the carved
 * `service-notification` consumer delivers on).
 *
 * Batch shape: each iteration runs one `$transaction` that (1) selects up
 * to `batchSize` expired-unrevoked rows, (2) stamps `revoked_at = now` on
 * exactly those rows (guarded `revokedAt: null`, so a concurrent manual
 * revoke never double-flips), and (3) appends one outbox event per row on
 * the same tx client — revocation and notification signal commit
 * atomically (CLAUDE.md §5.3). A failed batch rolls back whole; earlier
 * batches stay committed (each batch is independently correct).
 *
 * Idempotent: re-running finds nothing (revoked rows fail the
 * `revoked_at IS NULL` predicate). Concurrency-safe: two overlapping
 * sweeps race on the `revokedAt: null` guard — the loser updates zero
 * rows; at most one event per row is emitted per *committed* flip... the
 * select-then-update window can, in a pathological overlap, emit a
 * duplicate event for a row the other sweep flipped first — consumers are
 * idempotent on assignment-level dedup and the BullMQ job scheduler runs
 * the sweep singleton cluster-wide, so the window is theoretical.
 *
 * `revoked_at` is stamped with the SWEEP time, not `expires_at` — the
 * revocation happened now; the expiry moment is already on the row.
 *
 * Performance: the batch select rides `user_roles_user_active_idx`'s
 * `(user_id, revoked_at, expires_at)` shape poorly for a global scan, but
 * the steady-state result set is empty/tiny; if the sweep ever shows up
 * in slow-query logs the fix is a partial index on
 * `(expires_at) WHERE revoked_at IS NULL` (carved — see the TS-293 bank
 * notes) rather than a bigger batch.
 */
@Injectable()
export class RoleAssignmentExpiryService {
  private readonly logger = new Logger(RoleAssignmentExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RbacExpiryEmitter,
    private readonly audit: AuditEmitter,
  ) {}

  /**
   * Revoke every expired-unrevoked assignment, in bounded transaction
   * batches, emitting one `identity.role_assignment.expired` outbox event
   * + one audit log line per row. Loops until a batch comes back short
   * (the table is drained as of `now`).
   *
   * `now` is injectable for deterministic tests (CLAUDE.md §9.3 — no
   * sleeps, no clock races); the worker passes nothing.
   */
  async expireSweep(
    options: { readonly now?: Date; readonly batchSize?: number } = {},
  ): Promise<ExpireSweepResult> {
    const now = options.now ?? new Date();
    const batchSize = options.batchSize ?? EXPIRE_SWEEP_DEFAULT_BATCH_SIZE;

    let revokedCount = 0;
    let batchCount = 0;

    for (;;) {
      const flipped = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const rows: ExpiredRow[] = await tx.userRole.findMany({
          where: { revokedAt: null, expiresAt: { lt: now } },
          select: {
            id: true,
            userId: true,
            scopeType: true,
            scopeId: true,
            expiresAt: true,
            role: { select: { name: true } },
          },
          orderBy: { expiresAt: 'asc' },
          take: batchSize,
        });
        if (rows.length === 0) return rows;

        await tx.userRole.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, revokedAt: null },
          data: { revokedAt: now },
        });

        for (const row of rows) {
          await this.emitter.emitExpired(tx, {
            assignmentId: row.id,
            userId: row.userId,
            roleName: row.role.name,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            // The where-predicate guarantees non-null; guard for type
            // truth rather than assert.
            expiresAt: row.expiresAt ?? now,
            revokedAt: now,
          });
          // Durable audit trail per revocation (TS-295) — the sweep has
          // no human actor, so the event carries the `system` scope.
          const facts = {
            userId: row.userId,
            roleName: row.role.name,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            expiresAt: (row.expiresAt ?? now).toISOString(),
          };
          await this.audit.emit(tx, SYSTEM_AUDIT_ACTOR, {
            action: 'rbac_assignment:expire',
            resourceKind: RBAC_AUDIT_RESOURCE.assignment,
            resourceId: row.id,
            before: { ...facts, revokedAt: null },
            after: { ...facts, revokedAt: now.toISOString() },
          });
        }
        return rows;
      });

      if (flipped.length === 0) break;
      batchCount += 1;
      revokedCount += flipped.length;

      // Audit trail per revocation — the structured-logger scaffold every
      // identity admin mutation uses today (real outbox audit wire rides
      // TS-126-followup-5). Logged after commit so a rolled-back batch
      // never leaves phantom audit lines.
      for (const row of flipped) {
        this.logger.log(
          {
            actorId: null,
            action: 'rbac.assignment.expired',
            assignmentId: row.id,
            targetUserId: row.userId,
            role: row.role.name,
            scopeType: row.scopeType,
            expiresAt: row.expiresAt?.toISOString() ?? null,
            revokedAt: now.toISOString(),
          },
          'role assignment expired (swept)',
        );
      }

      if (flipped.length < batchSize) break;
    }

    return { revokedCount, batchCount };
  }
}
