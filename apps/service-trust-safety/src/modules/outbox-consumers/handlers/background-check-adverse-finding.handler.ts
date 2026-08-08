import { Injectable, Logger } from '@nestjs/common';
import { PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { IncidentsService } from '../../incidents/services/incidents.service';

/**
 * Handler for `provider.background_check.adverse_finding` (TS-307a;
 * PRD §10.14; PDD §16.2; CLAUDE.md §5.3, §12).
 *
 * **service-trust-safety's first outbox-consumer handler.** The module
 * has carried the surface since TS-302a with nothing registered on it.
 *
 * Opens a `safety` incident, `source: 'system'`, against the provider
 * named in the event, so a human reviews a finding against someone
 * already serving seniors.
 *
 * **Severity is decided HERE, not by the producer.** service-provider
 * knows a Checkr status changed; it does not know what this platform
 * considers urgent, and the same reasoning that kept the booking-hold
 * predicate on this side (TS-304) applies in the other direction. The
 * grading is deliberately coarse:
 *
 *   - `high` for `consider` / `suspended` / `failed` — a finding on an
 *     active provider needs a human inside the working day, and `high`
 *     is also what makes TS-304 suspend the provider's bookings while
 *     that review happens. That suspension is the point: the platform
 *     should stop sending someone into a senior's home before it knows
 *     what the report says, and lift it when it does.
 *   - `medium` for `dispute` — the candidate is contesting a finding
 *     that has already been reviewed once. It still needs a human, but
 *     it is not new information about risk, and grading it `high` would
 *     re-suspend a provider for exercising a statutory right.
 *
 * NOT `critical`: `critical` pages on-call at 3am (TS-306), and a
 * background-check result that has been sitting in Checkr is not a
 * senior in danger right now.
 *
 * **The incident carries no description.** Everything Checkr reported is
 * consumer-report content under FCRA and never left service-provider —
 * see the event contract. The console already renders a null description
 * as "opened by the system, not by a person", which is exactly right
 * here: the narrative lives in Checkr, and reading it is a step in the
 * adverse-action workflow (TS-307c), not something to copy into a row.
 *
 * **Idempotency (CLAUDE.md §5.3).** Two layers:
 *   1. The SDK's `trust_safety.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)`.
 *   2. `incidents.source_event_id`'s partial UNIQUE — the domain guard,
 *      which survives a truncated dedup table or a renamed consumer
 *      group. A duplicate raises P2002; the handler treats that as
 *      "already opened" and returns, because it is.
 *
 * **Failure handling.** Anything else throws, so the SDK leaves the
 * entry in the PEL for redelivery. A dropped finding is a provider
 * continuing to visit seniors with nobody having read their report.
 */
@Injectable()
export class BackgroundCheckAdverseFindingHandler {
  private readonly logger = new Logger(BackgroundCheckAdverseFindingHandler.name);

  constructor(private readonly incidents: IncidentsService) {}

  async handle(args: HandleArgs<typeof PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING>): Promise<void> {
    const { envelope, payload } = args;
    const severity = gradeAdverseFinding(payload.status);

    try {
      const incident = await this.incidents.createIncident({
        source: 'system',
        category: 'safety',
        severity,
        providerId: payload.providerId,
        sourceEventId: envelope.eventId,
        // TS-308c-followup-2 — the evidence a reviewer needs, in the one
        // place they will look. Still NOT the finding: what the report
        // SAYS never crosses a service boundary, and does not appear
        // here either. The categorical status is what graded this.
        evidence: {
          detector: 'background_check',
          backgroundCheckId: payload.backgroundCheckId,
          status: payload.status,
          previousStatus: payload.previousStatus ?? null,
        },
        // No `description` and no `reporterUserId` — see the doc-block.
      });

      // WARN: an active provider has an adverse background-check result.
      // That is a state an operator should find in the logs without knowing
      // to look for it.
      this.logger.warn(
        `trust_safety.background_check_adverse_finding.incident_opened ${JSON.stringify({
          eventId: envelope.eventId,
          incidentId: incident.id,
          providerId: payload.providerId,
          backgroundCheckId: payload.backgroundCheckId,
          previousStatus: payload.previousStatus,
          status: payload.status,
          severity,
        })}`,
      );
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `trust_safety.background_check_adverse_finding.already_opened ${JSON.stringify({
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
 * Map an adverse background-check status to an incident severity.
 *
 * Exported so the grading is testable on its own and so a future
 * re-grade path (or TS-307c's adverse-action workflow) reads the same
 * table rather than restating it.
 */
export function gradeAdverseFinding(
  status: 'consider' | 'suspended' | 'dispute' | 'failed',
): 'low' | 'medium' | 'high' | 'critical' {
  switch (status) {
    case 'dispute':
      return 'medium';
    case 'consider':
    case 'suspended':
    case 'failed':
      return 'high';
  }
}

/**
 * Prisma's unique-constraint violation. Matched structurally rather than
 * by importing `Prisma.PrismaClientKnownRequestError` — the value-side of
 * the `Prisma` namespace resolves inconsistently under this repo's
 * tsconfig (the TS-021-followup-2 root cause documented across the
 * services), and an `instanceof` against an unresolvable value is worse
 * than a shape check on a stable, documented error code.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code: unknown }).code === 'P2002'
  );
}
