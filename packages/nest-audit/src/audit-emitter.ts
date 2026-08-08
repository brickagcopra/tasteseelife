import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTION_RECORDED, type AuditActionRecorded } from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import type { AuditActor } from './audit-context';
import { AUDIT_PRODUCER_SERVICE } from './module/tokens';

/**
 * What changed — the action verb, the resource, and the DTO-projected
 * before/after snapshots. `before` is null for a create; snapshots are wire
 * DTOs, never raw Prisma rows (CLAUDE.md §3.3).
 *
 * `resourceKind` is a plain string rather than a shared union: the resource
 * vocabulary is per-bounded-context (`content_article`, `ads_campaign`,
 * `trust_safety_mandated_reporter_case`), so each service keeps its own
 * `*_AUDIT_RESOURCE` map as a local `as const`. Centralising that map would
 * make every service's table names a shared-package concern for no gain.
 */
export interface AuditMutationDescriptor {
  /** `resource:verb` permission-style action, e.g. `content_article:publish`. */
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly before: unknown | null;
  readonly after: unknown | null;
}

/**
 * Thrown when the outbox rejects the audit payload. The caller's transaction
 * must roll back — a mutation that cannot be audited must not commit
 * (CLAUDE.md §3.6).
 *
 * On most surfaces this is unreachable: the payload is built from typed inputs
 * and validated against the same schema, so it guards against future
 * schema/skew drift rather than a runtime user path. On a legal-record surface
 * (the mandated-reporter workflow) it is load-bearing — an unauditable signoff
 * is worse than a failed one.
 */
export class AuditEmitFailedError extends Error {
  constructor(
    readonly action: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`audit event rejected for action '${action}'`);
    this.name = 'AuditEmitFailedError';
  }
}

/**
 * Emits `audit.action_recorded` to the caller's transactional outbox
 * (TS-303b-followup-1; CLAUDE.md §3.6; PDD §7.3, §17.1).
 *
 * **`emit` takes the caller's transaction client** and is invoked from inside
 * `$transaction(async (tx) => …)`, so the audit row commits atomically with
 * the state change (the outbox invariant — CLAUDE.md §5.3). The relay
 * (`worker-outbox-relay`) drains each service's `outbox_events` onto Redis
 * Streams; `service-audit`'s consumer persists the event append-only +
 * hash-chained, idempotent on `eventId`. The same `eventId` is stamped on both
 * the outbox row and the payload envelope so dispatch dedup and consumer
 * idempotency agree.
 *
 * **The hash chain lives in service-audit, not here.** Chaining per resource
 * requires a single writer, and `service-audit`'s `HashChainService` already
 * is it. A local chain would fork the platform's tamper-evidence story into
 * several implementations, which on a legal-record surface is strictly worse
 * than one.
 *
 * **Snapshots are DTO projections, never raw rows**, and callers are expected
 * to omit PHI-bearing free text from them: the audit store is a second durable
 * system with its own retention and its own read surface, and the audit row's
 * job is to prove WHO changed WHAT and WHEN — not to duplicate the narrative
 * (CLAUDE.md §3.9). The emitter cannot enforce that; the doc-blocks on each
 * service's snapshot builders record it.
 */
@Injectable()
export class AuditEmitter {
  private readonly logger = new Logger(AuditEmitter.name);

  constructor(
    private readonly outbox: OutboxService,
    /**
     * The producing bounded context, e.g. `service-content`. Logged rather
     * than sent on the event — `audit.action_recorded` carries the actor and
     * the resource, and the resource kind already names the context.
     */
    @Inject(AUDIT_PRODUCER_SERVICE) private readonly producerService: string,
  ) {}

  async emit(
    tx: OutboxRawExecutor,
    actor: AuditActor,
    descriptor: AuditMutationDescriptor,
  ): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: AuditActionRecorded = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      actorTenantScopeType: actor.actorTenantScopeType,
      actorTenantScopeId: actor.actorTenantScopeId,
      action: descriptor.action,
      resourceKind: descriptor.resourceKind,
      resourceId: descriptor.resourceId,
      beforeJson: descriptor.before ?? null,
      afterJson: descriptor.after ?? null,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      traceId: actor.traceId,
    };

    const result = await this.outbox.append(tx, {
      eventName: AUDIT_ACTION_RECORDED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new AuditEmitFailedError(descriptor.action, result.issues);
    }

    this.logger.debug(
      `audit emitted producer=${this.producerService} action=${descriptor.action} resource=${descriptor.resourceKind}:${descriptor.resourceId} eventId=${eventId}`,
    );
  }
}
