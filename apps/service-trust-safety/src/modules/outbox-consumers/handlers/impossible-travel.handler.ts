import { Injectable, Logger } from '@nestjs/common';
import { BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { IncidentsService } from '../../incidents/services/incidents.service';

/**
 * Handler for `booking.anomaly.impossible_travel` (TS-308a; PRD §10.13;
 * PDD §17.3; CLAUDE.md §5.3, §12).
 *
 * service-trust-safety's second outbox-consumer handler, and the second
 * `source: 'system'` incident path (after TS-307a's background-check
 * finding).
 *
 * Opens a `safety` incident against the provider whose two check-ins
 * could not both be true.
 *
 * **Severity is decided HERE, not by the producer**, the same split as
 * TS-307a and the mirror of TS-304. service-booking computed a speed; it
 * does not know what this platform considers urgent.
 *
 *   - `medium` is the grade, and it is a deliberate step BELOW the
 *     background-check finding. An impossible-travel signal is a strong
 *     hint that something is wrong with a check-in, but the most common
 *     explanations are mundane — a device with a bad clock, a VPN or
 *     location-mocking app the provider installed for unrelated reasons,
 *     a check-in recorded from home after the fact. It needs a human to
 *     look at within the day; it is not, on its own, evidence that a
 *     senior was harmed.
 *   - **Never `high`**, because `high` triggers TS-304's booking hold:
 *     it would suspend every one of that provider's upcoming visits.
 *     Cancelling a week of care for a family on the strength of a GPS
 *     reading would do more harm than the anomaly it responds to, and
 *     the operator can escalate in one step once they have looked. If a
 *     pattern emerges, that is a human's call and a re-grade
 *     (TS-304-followup-2), not a detector's.
 *   - **Never `critical`** — that pages on-call at 3am (TS-306).
 *
 * **The incident carries no description**, and there is nothing to put
 * in one: the event deliberately carries no coordinates (a check-in
 * location is a senior's home address, CLAUDE.md §12), and the numbers
 * that justify the incident are on the event and in this log line. The
 * console renders a null description as "opened by the system, not by a
 * person", which is exactly what happened. A reviewer resolves the two
 * check-in ids inside service-booking, where the permission to see a
 * location already lives.
 *
 * **Idempotency (CLAUDE.md §5.3).** Three layers here, one more than
 * usual:
 *   1. The producer's event id is derived from the check-in pair, so a
 *      re-detected pair is a no-op at the outbox insert and never
 *      becomes a second event at all.
 *   2. The SDK's `trust_safety.outbox_consumer_dedup` PK.
 *   3. `incidents.source_event_id`'s partial UNIQUE — the domain guard
 *      that survives a truncated dedup table or a renamed consumer
 *      group. A duplicate raises P2002 and the handler returns, because
 *      the incident it would have opened already exists.
 *
 * **Failure handling.** Anything else throws, so the SDK leaves the
 * entry in the PEL for redelivery.
 */
@Injectable()
export class ImpossibleTravelHandler {
  private readonly logger = new Logger(ImpossibleTravelHandler.name);

  constructor(private readonly incidents: IncidentsService) {}

  async handle(args: HandleArgs<typeof BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL>): Promise<void> {
    const { envelope, payload } = args;

    try {
      const incident = await this.incidents.createIncident({
        source: 'system',
        category: 'safety',
        severity: IMPOSSIBLE_TRAVEL_SEVERITY,
        providerId: payload.providerId,
        sourceEventId: envelope.eventId,
        // TS-308c-followup-2 — the derived scalars, recorded where a
        // reviewer will look. Still NO coordinates: the ids are handles
        // they resolve inside service-booking, which is where the
        // permission to see a location already lives.
        evidence: {
          detector: 'impossible_travel',
          previousCheckInId: payload.previousCheckInId,
          checkInId: payload.checkInId,
          previousBookingId: payload.previousBookingId,
          bookingId: payload.bookingId,
          distanceMeters: payload.distanceMeters,
          elapsedSeconds: payload.elapsedSeconds,
          impliedSpeedKph: payload.impliedSpeedKph,
          thresholdKph: payload.thresholdKph,
          previousOccurredAt: payload.previousOccurredAt,
          occurredAt: payload.occurredAt,
        },
        // No `description` and no `reporterUserId` — see the doc-block.
      });

      // WARN, not info: a provider's check-ins contradicting each other is
      // a state an operator should find in the logs without knowing to
      // look for it. Every field here is a derived scalar or an id —
      // there is no location in this line, by construction.
      this.logger.warn(
        `trust_safety.impossible_travel.incident_opened ${JSON.stringify({
          eventId: envelope.eventId,
          incidentId: incident.id,
          providerId: payload.providerId,
          previousCheckInId: payload.previousCheckInId,
          checkInId: payload.checkInId,
          distanceMeters: payload.distanceMeters,
          elapsedSeconds: payload.elapsedSeconds,
          impliedSpeedKph: payload.impliedSpeedKph,
          thresholdKph: payload.thresholdKph,
          severity: IMPOSSIBLE_TRAVEL_SEVERITY,
        })}`,
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `trust_safety.impossible_travel.already_opened ${JSON.stringify({
            eventId: envelope.eventId,
            providerId: payload.providerId,
          })}`,
        );
        return;
      }
      throw error;
    }
  }
}

/**
 * The grade for an impossible-travel finding.
 *
 * A named constant rather than an inline literal because the choice is
 * load-bearing and cross-service: `high` would make TS-304 suspend the
 * provider's bookings, and this signal is not strong enough to cancel a
 * family's week of care on. Exported so a re-grade path reads the same
 * value rather than restating it.
 */
export const IMPOSSIBLE_TRAVEL_SEVERITY = 'medium' as const;

/**
 * Prisma's unique-constraint violation, matched structurally. Same
 * reasoning as the background-check handler: the value-side of the
 * `Prisma` namespace resolves inconsistently under this repo's tsconfig
 * (TS-021-followup-2), and a shape check on a stable, documented error
 * code beats an `instanceof` against an unresolvable value.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
