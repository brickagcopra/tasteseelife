import { Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTION_RECORDED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { AuditService, type RecordEventInput } from '../../audit/services/audit.service';

/**
 * Handler for `audit.action_recorded` events landed via the outbox relay
 * (TS-271a-followup-1 / TS-272a-followup-1 / TS-277a-followup-1; PDD §7.4,
 * §17.1; CLAUDE.md §3.6, §5.3).
 *
 * This is the consumer half of the platform audit trail: every producer that
 * mutates an admin-owned resource appends an `audit.action_recorded` event to
 * its outbox INSIDE the mutation transaction (service-ads is the first); the
 * worker-outbox-relay drains it onto Redis Streams; this handler maps the
 * event payload 1:1 onto `AuditService.recordEvent`, which persists it
 * append-only with a per-resource SHA-256 hash chain.
 *
 * **Idempotency.** Idempotent on `envelope.eventId` at two layers:
 *   1. Consumer SDK — `audit.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)` short-circuits a redelivery before this
 *      code runs (CLAUDE.md §5.3).
 *   2. Service-layer — `audit_events.event_id` UNIQUE. Even if the SDK dedup
 *      table is wiped, `recordEvent` detects the replay and returns
 *      `outcome: 'replayed'` WITHOUT re-chaining or overwriting the row.
 *   The producer-stamped `payload.eventId` IS the row's `eventId` (the emitter
 *   stamps the same id on the outbox row + the payload envelope), so the relay
 *   envelope id and the audit row id agree.
 *
 * **No tenant frame.** The producer stamps the actor's scope
 * (`actorTenantScopeType` / `actorTenantScopeId`) into the event payload; the
 * audit service writes it verbatim. The handler dispatch is wrapped in
 * `runWithoutTenantContext` at registration (see `outbox-consumers.module.ts`)
 * because the consumer runs off the poll loop, not an HTTP request.
 *
 * **Failure handling.** Any `recordEvent` failure throws, so the SDK records
 * the attempt + leaves the entry in the PEL for redelivery (and dead-letters
 * after `OUTBOX_CONSUMER_MAX_ATTEMPTS`). Audit persistence must not silently
 * drop an event.
 */
@Injectable()
export class AuditActionRecordedHandler {
  private readonly logger = new Logger(AuditActionRecordedHandler.name);

  constructor(private readonly audit: AuditService) {}

  async handle(args: HandleArgs<typeof AUDIT_ACTION_RECORDED>): Promise<void> {
    const { envelope, payload } = args;

    const input: RecordEventInput = {
      eventId: payload.eventId,
      occurredAt: new Date(payload.occurredAt),
      actorUserId: payload.actorUserId,
      actorRole: payload.actorRole,
      actorTenantScopeType: payload.actorTenantScopeType,
      actorTenantScopeId: payload.actorTenantScopeId,
      action: payload.action,
      resourceKind: payload.resourceKind,
      resourceId: payload.resourceId,
      beforeJson: payload.beforeJson,
      afterJson: payload.afterJson,
      ip: payload.ip,
      userAgent: payload.userAgent,
      requestId: payload.requestId,
      traceId: payload.traceId,
    };

    const result = await this.audit.recordEvent(input);

    this.logger.log(
      {
        eventId: envelope.eventId,
        producerService: envelope.producerService,
        action: payload.action,
        resourceKind: payload.resourceKind,
        resourceId: payload.resourceId,
        outcome: result.outcome,
      },
      result.outcome === 'recorded'
        ? 'outbox.audit-action-recorded.persisted'
        : 'outbox.audit-action-recorded.replayed',
    );
  }
}
