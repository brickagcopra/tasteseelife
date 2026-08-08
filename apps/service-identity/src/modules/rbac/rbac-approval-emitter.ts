import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED,
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED,
  type IdentityRbacScopeType,
  type IdentityRoleApprovalOutcome,
  type IdentityRoleAssignmentApprovalDecided,
  type IdentityRoleAssignmentApprovalRequested,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/** The grant-request facts both approval events carry. Ids only — no PII. */
export interface RoleApprovalDescriptor {
  readonly approvalId: string;
  readonly userId: string;
  readonly roleName: string;
  readonly scopeType: IdentityRbacScopeType;
  readonly scopeId: string | null;
  /** Expiration the eventual grant will carry (null = no expiry). */
  readonly expiresAt: Date | null;
  readonly requestedByUserId: string;
}

export interface RoleApprovalDecisionDescriptor extends RoleApprovalDescriptor {
  readonly status: IdentityRoleApprovalOutcome;
  /** Null only when a staleness sweep expires the request with no human decider. */
  readonly decidedByUserId: string | null;
  readonly decidedAt: Date;
  /** The `user_roles` row minted on approval; null for rejected / expired. */
  readonly userRoleId: string | null;
}

/**
 * Raised when the outbox append rejects an approval event — thrown INSIDE
 * the flow transaction so the state change rolls back (a decided approval
 * that cannot durably queue its audit/notification signal must not commit;
 * CLAUDE.md §5.3). Same rationale as `RbacExpiryEmitFailedError`.
 */
export class RbacApprovalEmitFailedError extends Error {
  constructor(
    readonly approvalId: string,
    readonly eventName: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`${eventName} payload validation failed for approval '${approvalId}'`);
    this.name = 'RbacApprovalEmitFailedError';
  }
}

/**
 * Emits the TS-294 reviewer-flow events to the transactional outbox
 * (`identity.outbox_events`, already relayed — no config change):
 *
 *   - `identity.role_assignment_approval.requested` — with the
 *     `role_assignment_approvals` insert
 *   - `identity.role_assignment_approval.decided`  — with the terminal
 *     status update (approve / reject / future expiry sweep)
 *
 * Call from INSIDE the flow `$transaction` (same in-tx append shape as
 * `RbacExpiryEmitter`). Consumers are idempotent on `eventId`.
 */
@Injectable()
export class RbacApprovalEmitter {
  private readonly logger = new Logger(RbacApprovalEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitRequested(
    tx: OutboxRawExecutor,
    descriptor: RoleApprovalDescriptor,
    occurredAt: Date,
  ): Promise<void> {
    const eventId = randomUUID();
    const payload: IdentityRoleAssignmentApprovalRequested = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      approvalId: descriptor.approvalId,
      userId: descriptor.userId,
      roleName: descriptor.roleName,
      scopeType: descriptor.scopeType,
      scopeId: descriptor.scopeId,
      expiresAt: descriptor.expiresAt?.toISOString() ?? null,
      requestedByUserId: descriptor.requestedByUserId,
    };

    const result = await this.outbox.append(tx, {
      eventName: IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new RbacApprovalEmitFailedError(
        descriptor.approvalId,
        IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED,
        result.issues,
      );
    }

    this.logger.log(
      {
        approvalId: descriptor.approvalId,
        userId: descriptor.userId,
        roleName: descriptor.roleName,
        requestedByUserId: descriptor.requestedByUserId,
        eventId,
      },
      'identity.role_assignment_approval.requested emitted',
    );
  }

  async emitDecided(
    tx: OutboxRawExecutor,
    descriptor: RoleApprovalDecisionDescriptor,
  ): Promise<void> {
    const eventId = randomUUID();
    const payload: IdentityRoleAssignmentApprovalDecided = {
      eventId,
      occurredAt: descriptor.decidedAt.toISOString(),
      approvalId: descriptor.approvalId,
      userId: descriptor.userId,
      roleName: descriptor.roleName,
      scopeType: descriptor.scopeType,
      scopeId: descriptor.scopeId,
      expiresAt: descriptor.expiresAt?.toISOString() ?? null,
      requestedByUserId: descriptor.requestedByUserId,
      status: descriptor.status,
      decidedByUserId: descriptor.decidedByUserId,
      decidedAt: descriptor.decidedAt.toISOString(),
      userRoleId: descriptor.userRoleId,
    };

    const result = await this.outbox.append(tx, {
      eventName: IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED,
      payload,
      eventId,
      occurredAt: descriptor.decidedAt,
    });
    if (result.kind !== 'appended') {
      throw new RbacApprovalEmitFailedError(
        descriptor.approvalId,
        IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED,
        result.issues,
      );
    }

    this.logger.log(
      {
        approvalId: descriptor.approvalId,
        status: descriptor.status,
        decidedByUserId: descriptor.decidedByUserId,
        requestedByUserId: descriptor.requestedByUserId,
        userRoleId: descriptor.userRoleId,
        eventId,
      },
      'identity.role_assignment_approval.decided emitted',
    );
  }
}
