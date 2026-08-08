import { Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_ANOMALY_MASS_CANCELLATION,
  type BookingAnomalySubjectKind,
  type TrustSafetyIncidentCategory,
  type TrustSafetyIncidentSeverity,
} from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { IncidentsService } from '../../incidents/services/incidents.service';

/**
 * Handler for `booking.anomaly.mass_cancellation` (TS-308c; PRD §10.13;
 * PDD §17.3; CLAUDE.md §5.3, §12).
 *
 * service-trust-safety's third outbox-consumer handler, and the third
 * `source: 'system'` incident path (after TS-307a's background-check
 * finding and TS-308a's impossible travel).
 *
 * **The grade and the category both depend on the SUBJECT, and that is
 * the point of the handler.** service-booking counted cancellations; it
 * has no view on what this platform does about them, and the two
 * subjects want genuinely different responses:
 *
 *   - **provider → `conduct`, `medium`.** A provider's committed day of
 *     care disappearing is felt by several families at once, and the
 *     explanations range from illness to walking off the job. `medium`
 *     buys a 24h SLA, which matches: someone should look today, and the
 *     visits are already gone so there is nothing to page anyone about
 *     at 3am.
 *   - **household → `billing`, `low`.** The concern here is
 *     cancellation-policy abuse (CLAUDE.md §12), and `billing` says that
 *     plainly. `low` and its 72h SLA are deliberate, because **the most
 *     likely explanation is a family in crisis** — a senior hospitalised,
 *     a bereavement — cancelling everything at once. The producer
 *     collapses a cancelled recurring series to one decision and sets a
 *     high threshold precisely to keep those families out of this queue,
 *     but it cannot rule them out. A reviewer's FIRST job on one of
 *     these is to check for that, and nothing in the incident should
 *     have implied otherwise before they did.
 *
 * **Never `high`** — for a sharper reason than TS-308a's. `high` triggers
 * TS-304's booking hold, which suspends the subject's remaining visits.
 * On a mass-cancellation finding that means **the platform's response to
 * care being cancelled would be to cancel more care.** The detector would
 * amplify exactly the harm it exists to notice.
 *
 * **Never `critical`** — that pages on-call at 3am (TS-306), and there is
 * nothing to do at 3am about visits that have already been cancelled.
 *
 * **The incident carries no description**, and there is nothing to put in
 * one: the event carries counts and a window by design (no cancellation
 * reasons, no free text — a per-row reason says something about a named
 * senior's circumstances). The console renders a null description as
 * "opened by the system, not by a person", which is what happened.
 *
 * **Idempotency (CLAUDE.md §5.3).** Three layers, as with TS-308a:
 *   1. The producer's event id is derived from `{subject}:{UTC day}`, so
 *      a rolling window re-observed ninety-six times a day is a no-op at
 *      the outbox insert after the first.
 *   2. The SDK's `trust_safety.outbox_consumer_dedup` PK.
 *   3. `incidents.source_event_id`'s partial UNIQUE — the domain guard
 *      that survives a truncated dedup table or a renamed consumer group.
 *
 * **Failure handling.** Anything else throws, so the SDK leaves the entry
 * in the PEL for redelivery.
 */
@Injectable()
export class MassCancellationHandler {
  private readonly logger = new Logger(MassCancellationHandler.name);

  constructor(private readonly incidents: IncidentsService) {}

  async handle(args: HandleArgs<typeof BOOKING_ANOMALY_MASS_CANCELLATION>): Promise<void> {
    const { envelope, payload } = args;
    const grade = gradeMassCancellation(payload.subjectKind);

    try {
      const incident = await this.incidents.createIncident({
        source: 'system',
        category: grade.category,
        severity: grade.severity,
        sourceEventId: envelope.eventId,
        // TS-308c-followup-2 — the counts and the window, recorded where
        // a reviewer will look. No reasons and no free text here either,
        // for the reason the event gives.
        evidence: {
          detector: 'mass_cancellation',
          subjectKind: payload.subjectKind,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          canceledBookingCount: payload.canceledBookingCount,
          distinctCancellationCount: payload.distinctCancellationCount,
          threshold: payload.threshold,
          distinctActorCount: payload.distinctActorCount,
          unattributedCount: payload.unattributedCount,
          staffExcludedCount: payload.staffExcludedCount,
        },
        // Exactly one subject is named — the one the count was about.
        // Naming both would assert that a household whose bookings
        // happen to sit in a breaching provider's window is itself
        // under review.
        ...(payload.subjectKind === 'provider'
          ? { providerId: payload.subjectId }
          : { householdId: payload.subjectId }),
        // No `description` and no `reporterUserId` — see the doc-block.
      });

      // WARN, not info: a subject's care commitments evaporating is a
      // state an operator should find in the logs without knowing to
      // look for it. Every field is a count, an id, or a window — the
      // event carries nothing else, by construction.
      this.logger.warn(
        `trust_safety.mass_cancellation.incident_opened ${JSON.stringify({
          eventId: envelope.eventId,
          incidentId: incident.id,
          subjectKind: payload.subjectKind,
          subjectId: payload.subjectId,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          canceledBookingCount: payload.canceledBookingCount,
          distinctCancellationCount: payload.distinctCancellationCount,
          threshold: payload.threshold,
          distinctActorCount: payload.distinctActorCount,
          unattributedCount: payload.unattributedCount,
          staffExcludedCount: payload.staffExcludedCount,
          category: grade.category,
          severity: grade.severity,
        })}`,
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `trust_safety.mass_cancellation.already_opened ${JSON.stringify({
            eventId: envelope.eventId,
            subjectKind: payload.subjectKind,
            subjectId: payload.subjectId,
          })}`,
        );
        return;
      }
      throw error;
    }
  }
}

/**
 * The category + severity for a mass-cancellation finding, by subject.
 *
 * A function rather than inline literals because the choice is
 * load-bearing and cross-service — see the class doc-block for the
 * reasoning, and note in particular that neither branch may ever return
 * `high`, which would make TS-304 suspend the subject's remaining
 * bookings in response to bookings being cancelled.
 */
export function gradeMassCancellation(subjectKind: BookingAnomalySubjectKind): {
  readonly category: TrustSafetyIncidentCategory;
  readonly severity: TrustSafetyIncidentSeverity;
} {
  return subjectKind === 'provider'
    ? { category: 'conduct', severity: 'medium' }
    : { category: 'billing', severity: 'low' };
}

/**
 * Prisma's unique-constraint violation, matched structurally. Same
 * reasoning as the sibling handlers: the value-side of the `Prisma`
 * namespace resolves inconsistently under this repo's tsconfig
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
