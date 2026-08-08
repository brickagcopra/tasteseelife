import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
  type TrustSafetyBookingHoldReleased,
  type TrustSafetyBookingHoldRequested,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { isBookingHoldEligible } from './booking-hold-policy';
import type { IncidentRow } from './repositories/incident.repository';

/**
 * Raised when the outbox append rejects a booking-hold event. Thrown INSIDE
 * the caller's transaction so the incident mutation rolls back with it.
 *
 * The reasoning is the same as `IncidentCreatedEmitFailedError`'s but the
 * consequence is sharper in the release direction: an incident that resolved
 * without durably queueing its RELEASE would leave a household's bookings
 * suspended with no open incident to explain it and nothing left to lift it.
 * Rolling the resolution back keeps the incident open — visible in the queue,
 * with an operator able to try again — which is the recoverable failure.
 */
export class BookingHoldEmitFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly incidentId: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`${eventName} payload validation failed for '${incidentId}'`);
    this.name = 'BookingHoldEmitFailedError';
  }
}

/**
 * Emits the booking-hold pair (TS-304; PRD §10.14; PDD §16.1; CLAUDE.md
 * §5.3, §12).
 *
 * Both methods are **conditional no-ops**: they consult
 * `isBookingHoldEligible` and return without appending when the incident is
 * not hold-worthy. That keeps the eligibility rule in exactly one place and
 * makes the call sites in `IncidentsService` unconditional — a future insert
 * path (TS-302's escalation consumers) gets the hold behaviour for free
 * instead of having to remember a predicate.
 *
 * Call both from INSIDE the incident transaction (`onPersist`), so the hold
 * signal and the incident state change commit together.
 *
 * **The release is emitted for every eligible incident on resolution, even
 * one whose hold request may never have been applied** (booking down at open,
 * event dead-lettered, hold already cleared by an operator). The consumer's
 * release is a converging operation, not a paired decrement — a release for
 * a hold that was never applied clears nothing and is not an error. The
 * asymmetric failure is the other one: skipping a release because we assumed
 * the request had failed would strand the suspension.
 */
@Injectable()
export class BookingHoldEmitter {
  private readonly logger = new Logger(BookingHoldEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  /**
   * Append `trust_safety.booking_hold.requested` for a newly opened
   * incident. No-op when the incident is not `high`/`critical` or names no
   * subject.
   */
  async emitHoldRequested(tx: OutboxRawExecutor, incident: IncidentRow): Promise<void> {
    if (!isBookingHoldEligible(incident)) return;

    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: TrustSafetyBookingHoldRequested = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      incidentId: incident.id,
      severity: incident.severity,
      category: incident.category,
      providerId: incident.providerId,
      seniorId: incident.seniorId,
      householdId: incident.householdId,
      // The incident's own clock, not the publisher's — a backfilled
      // incident should hold from when the concern arose.
      requestedAt: incident.openedAt.toISOString(),
    };

    await this.append(tx, TRUST_SAFETY_BOOKING_HOLD_REQUESTED, payload, eventId, occurredAt);

    this.logger.log(
      `trust_safety.booking_hold.requested emitted ${JSON.stringify({
        incidentId: incident.id,
        severity: incident.severity,
        providerId: incident.providerId,
        seniorId: incident.seniorId,
        householdId: incident.householdId,
        eventId,
      })}`,
    );
  }

  /**
   * Append `trust_safety.booking_hold.released` for a resolved incident.
   * No-op under the same predicate as the request, so an incident that never
   * held anything does not publish a release for it.
   *
   * @param resolvedAt the resolution moment from the update — passed
   *        explicitly rather than read off `incident.resolvedAt` so the
   *        caller's injected clock governs (CLAUDE.md §9.3).
   */
  async emitHoldReleased(
    tx: OutboxRawExecutor,
    incident: IncidentRow,
    resolvedAt: Date,
  ): Promise<void> {
    if (!isBookingHoldEligible(incident)) return;

    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: TrustSafetyBookingHoldReleased = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      incidentId: incident.id,
      severity: incident.severity,
      category: incident.category,
      providerId: incident.providerId,
      seniorId: incident.seniorId,
      householdId: incident.householdId,
      releasedAt: resolvedAt.toISOString(),
    };

    await this.append(tx, TRUST_SAFETY_BOOKING_HOLD_RELEASED, payload, eventId, occurredAt);

    this.logger.log(
      `trust_safety.booking_hold.released emitted ${JSON.stringify({
        incidentId: incident.id,
        severity: incident.severity,
        providerId: incident.providerId,
        seniorId: incident.seniorId,
        householdId: incident.householdId,
        eventId,
      })}`,
    );
  }

  private async append(
    tx: OutboxRawExecutor,
    eventName:
      | typeof TRUST_SAFETY_BOOKING_HOLD_REQUESTED
      | typeof TRUST_SAFETY_BOOKING_HOLD_RELEASED,
    payload: TrustSafetyBookingHoldRequested | TrustSafetyBookingHoldReleased,
    eventId: string,
    occurredAt: Date,
  ): Promise<void> {
    const result = await this.outbox.append(tx, { eventName, payload, eventId, occurredAt });
    if (result.kind !== 'appended') {
      throw new BookingHoldEmitFailedError(eventName, payload.incidentId, result.issues);
    }
  }
}
