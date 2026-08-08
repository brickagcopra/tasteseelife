import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  IDENTITY_ROLE_ASSIGNMENT_EXPIRED,
  type IdentityRbacScopeType,
  type IdentityRoleAssignmentExpired,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/**
 * The facts one revoked-on-expiry assignment carries onto the bus. Ids +
 * role name only — no PII (the consumer resolves the recipient itself).
 */
export interface RoleAssignmentExpiredDescriptor {
  readonly assignmentId: string;
  readonly userId: string;
  readonly roleName: string;
  readonly scopeType: IdentityRbacScopeType;
  readonly scopeId: string | null;
  /** The row's expiry moment. */
  readonly expiresAt: Date;
  /** When the sweep stamped `revoked_at`. */
  readonly revokedAt: Date;
}

/**
 * Raised when the outbox append rejects an expiry event (a producer-side
 * validation failure). Thrown INSIDE the sweep transaction so the whole
 * batch rolls back — a revoked row that cannot durably queue its
 * notification signal must not commit (the outbox invariant, CLAUDE.md
 * §5.3). In practice unreachable: the payload is built from typed row data
 * validated against the same registry schema, so this guards future
 * schema/skew drift.
 */
export class RbacExpiryEmitFailedError extends Error {
  constructor(
    readonly assignmentId: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(
      `${IDENTITY_ROLE_ASSIGNMENT_EXPIRED} payload validation failed for assignment '${assignmentId}'`,
    );
    this.name = 'RbacExpiryEmitFailedError';
  }
}

/**
 * Emits `identity.role_assignment.expired` (TS-293; CLAUDE.md §5.3) to the
 * transactional outbox — identity's FIRST outbox producer (the table + SDK
 * shipped ahead in TS-142-followup-1).
 *
 * Call `emitExpired(tx, descriptor)` from INSIDE the sweep `$transaction`
 * so the notification signal commits atomically with the revocation. The
 * relay (`worker-outbox-relay`) already drains `identity.outbox_events` —
 * a new event NAME on the same table needs no relay-config change. The
 * (carved) `service-notification` consumer is idempotent on `eventId`.
 * Same in-tx append shape as service-content's `ContentSearchEmitter`.
 */
@Injectable()
export class RbacExpiryEmitter {
  private readonly logger = new Logger(RbacExpiryEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitExpired(
    tx: OutboxRawExecutor,
    descriptor: RoleAssignmentExpiredDescriptor,
  ): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = descriptor.revokedAt;
    const payload: IdentityRoleAssignmentExpired = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      assignmentId: descriptor.assignmentId,
      userId: descriptor.userId,
      roleName: descriptor.roleName,
      scopeType: descriptor.scopeType,
      scopeId: descriptor.scopeId,
      expiresAt: descriptor.expiresAt.toISOString(),
      revokedAt: descriptor.revokedAt.toISOString(),
    };

    const result = await this.outbox.append(tx, {
      eventName: IDENTITY_ROLE_ASSIGNMENT_EXPIRED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new RbacExpiryEmitFailedError(descriptor.assignmentId, result.issues);
    }

    this.logger.log(
      {
        assignmentId: descriptor.assignmentId,
        userId: descriptor.userId,
        roleName: descriptor.roleName,
        eventId,
      },
      'identity.role_assignment.expired emitted',
    );
  }
}
