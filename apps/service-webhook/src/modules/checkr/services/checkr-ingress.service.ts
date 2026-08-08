import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

import { BackgroundCheckDispatchService } from './background-check-dispatch.service';
import type { CheckrEventEnvelope } from './checkr-webhook-verifier.service';

export type CheckrIngressOutcome = 'persisted' | 'duplicate';

/**
 * Persists a verified Checkr event row, idempotent on `event.id`.
 *
 * Same shape and rationale as `StripeIngressService` (TS-041a):
 *   - Insert-and-catch on the primary key. The happy path is one
 *     INSERT; the duplicate path is one INSERT that hits P2002
 *     (unique-constraint violation) and is caught here.
 *   - No PII in logs.
 *   - Cross-service dispatch lives in the same place as KYC's —
 *     after persist, when the event matches `report.*`, hand off
 *     to `BackgroundCheckDispatchService` and stamp `dispatched_at`
 *     on success.
 */
@Injectable()
export class CheckrIngressService {
  private readonly logger = new Logger(CheckrIngressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: BackgroundCheckDispatchService,
  ) {}

  async persist(args: {
    readonly event: CheckrEventEnvelope;
    readonly payload: unknown;
    readonly verifiedAt: Date;
  }): Promise<CheckrIngressOutcome> {
    const { event, payload, verifiedAt } = args;
    try {
      await this.prisma.checkrProcessedEvent.create({
        data: {
          eventId: event.id,
          eventType: event.type,
          accountId: event.accountId,
          objectKind: event.object.kind,
          objectId: event.object.id,
          // The verified payload is a parsed JSON value; cast at
          // this one boundary because Prisma's `InputJsonValue`
          // namespace export resolves inconsistently under our
          // tsconfig (same root cause as TS-021-followup-2/3).
          payload: payload as unknown as object,
          signatureVerifiedAt: verifiedAt,
        },
      });

      this.logger.log(
        {
          eventId: event.id,
          eventType: event.type,
          objectId: event.object.id,
          outcome: 'persisted',
        },
        'checkr event persisted',
      );

      // Synchronous best-effort dispatch — same shape as
      // `StripeIngressService` + `StripeIdentityKycDispatchService`.
      if (BackgroundCheckDispatchService.isDispatchable(event.type)) {
        const outcome = await this.dispatcher.dispatch(event, payload);
        if (outcome !== null) {
          await this.dispatcher.markDispatched(event.id);
        }
      }

      return 'persisted';
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        this.logger.log(
          {
            eventId: event.id,
            eventType: event.type,
            objectId: event.object.id,
            outcome: 'duplicate',
          },
          'checkr event duplicate (already persisted)',
        );
        return 'duplicate';
      }
      throw err;
    }
  }
}

/**
 * `Prisma.PrismaClientKnownRequestError` with `code === 'P2002'` is
 * the unique-constraint violation we expect on duplicate event id
 * replays. Duck-typed for the same TS-021-followup-2 root cause as
 * the Stripe ingress.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === 'P2002' && candidate.name === 'PrismaClientKnownRequestError';
}
