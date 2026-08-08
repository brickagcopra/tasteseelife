import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
  type ProviderAdverseBackgroundCheckStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import type { BackgroundCheckRecordStatus } from './background-check.service';
import { shouldRaiseAdverseFinding, type ProviderRecordStatus } from './adverse-finding-policy';

export interface AdverseFindingInput {
  readonly providerId: string;
  readonly backgroundCheckId: string;
  readonly previousStatus: BackgroundCheckRecordStatus;
  readonly nextStatus: BackgroundCheckRecordStatus;
  readonly providerStatus: ProviderRecordStatus;
  /** Checkr's own event id — the deterministic half of the outbox key. */
  readonly checkrEventId: string;
  /** When Checkr says it happened, not when we processed it. */
  readonly occurredAt: Date;
}

/**
 * Emits `provider.background_check.adverse_finding` (TS-307a).
 *
 * **Rides the caller's transaction.** The append goes through the same
 * `tx` that writes the status update, so a webhook whose write rolls
 * back never raises an incident, and a raised incident always
 * corresponds to a persisted finding (CLAUDE.md §5.3).
 *
 * **No-op for anything the policy does not consider a finding**, so the
 * call site stays unconditional — same shape as trust-safety's
 * `booking-hold-emitter` (TS-304). The predicate lives in
 * `adverse-finding-policy.ts`; this class only decides how to phrase
 * what the policy already decided.
 *
 * **The event id is deterministic on Checkr's event id** — the outbox
 * key is `{backgroundCheckId}.adverse.{checkrEventId}`. Checkr
 * redelivers; the caller's `lastEventId` check already stops a replay
 * before we get here, but if that guard ever moves, a re-processed
 * event still cannot produce a second incident.
 */
@Injectable()
export class AdverseFindingEmitter {
  private readonly logger = new Logger(AdverseFindingEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitAdverseFinding(
    executor: OutboxRawExecutor,
    input: AdverseFindingInput,
  ): Promise<boolean> {
    if (
      !shouldRaiseAdverseFinding({
        nextStatus: input.nextStatus,
        providerStatus: input.providerStatus,
      })
    ) {
      return false;
    }

    // Narrowed by the policy above — `shouldRaiseAdverseFinding` returns
    // true only for the four adverse statuses, which is exactly the
    // event schema's union. Asserted rather than re-checked so the two
    // cannot drift apart silently; a widened policy with an unwidened
    // schema fails the outbox's own payload validation on the next line.
    const status = input.nextStatus as ProviderAdverseBackgroundCheckStatus;
    const eventId = `${input.backgroundCheckId}.adverse.${input.checkrEventId}`;

    await this.outbox.append(executor, {
      eventName: PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
      eventId,
      occurredAt: input.occurredAt,
      payload: {
        eventId,
        occurredAt: input.occurredAt.toISOString(),
        providerId: input.providerId,
        backgroundCheckId: input.backgroundCheckId,
        previousStatus: input.previousStatus,
        status,
        providerStatus: input.providerStatus,
      },
    });

    // Statuses and ids only — nothing Checkr reported reaches this line,
    // and nothing should ever be added to it.
    this.logger.warn(
      `provider.background_check.adverse_finding ${JSON.stringify({
        providerId: input.providerId,
        backgroundCheckId: input.backgroundCheckId,
        previousStatus: input.previousStatus,
        status,
      })}`,
    );
    return true;
  }
}
