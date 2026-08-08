import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  TRUST_SAFETY_INCIDENT_CREATED,
  type TrustSafetyIncidentCreated,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import type { IncidentRow } from './repositories/incident.repository';

/**
 * Raised when the outbox append rejects the incident-created event (a
 * producer-side validation failure). Thrown INSIDE the insert transaction so
 * the whole intake rolls back — an incident that cannot durably queue its
 * signal must not exist silently (the outbox invariant, CLAUDE.md §5.3; for
 * a welfare concern, "stored but never surfaced" is the exact failure mode
 * CLAUDE.md §12 forbids). In practice unreachable: the payload is built from
 * a typed row validated against the same registry schema, so this guards a
 * future schema-drift.
 */
export class IncidentCreatedEmitFailedError extends Error {
  constructor(
    readonly incidentId: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`${TRUST_SAFETY_INCIDENT_CREATED} payload validation failed for '${incidentId}'`);
    this.name = 'IncidentCreatedEmitFailedError';
  }
}

/**
 * Emits `trust_safety.incident.created` (TS-301a; PDD §7.4; CLAUDE.md §5.3)
 * to the transactional outbox.
 *
 * Call `emitCreated(tx, row)` from INSIDE the insert `$transaction` so the
 * signal commits atomically with the incident. The payload carries ids +
 * triage facts only — the report `description` is PII/PHI and NEVER rides an
 * event (see the contract doc). Consumers (TS-302 escalation / notification
 * routing — carved) are idempotent on `eventId`. Sibling of the
 * content/identity emitters (the same in-tx append shape).
 */
@Injectable()
export class IncidentCreatedEmitter {
  private readonly logger = new Logger(IncidentCreatedEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitCreated(tx: OutboxRawExecutor, incident: IncidentRow): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: TrustSafetyIncidentCreated = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      incidentId: incident.id,
      category: incident.category,
      severity: incident.severity,
      source: incident.source,
      householdId: incident.householdId,
      seniorId: incident.seniorId,
      openedAt: incident.openedAt.toISOString(),
      slaDueAt: incident.slaDueAt.toISOString(),
    };

    const result = await this.outbox.append(tx, {
      eventName: TRUST_SAFETY_INCIDENT_CREATED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new IncidentCreatedEmitFailedError(incident.id, result.issues);
    }

    this.logger.log(
      `trust_safety.incident.created emitted ${JSON.stringify({
        incidentId: incident.id,
        category: incident.category,
        severity: incident.severity,
        source: incident.source,
        eventId,
      })}`,
    );
  }
}
