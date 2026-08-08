import type { Logger } from '@nestjs/common';
import { TRUST_SAFETY_BOOKING_HOLD_REQUESTED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ApplySubjectHoldInput,
  SubjectHoldsService,
} from '../../subject-holds/services/subject-holds.service';
import { BookingHoldRequestedHandler } from './booking-hold-requested.handler';

const REQUESTED_AT = '2026-07-26T10:00:00.000Z';

/** Records what the handler asked the hold service to do. */
class FakeSubjectHoldsService {
  readonly applied: ApplySubjectHoldInput[] = [];
  failWith: Error | null = null;

  applySubjectHold = async (
    input: ApplySubjectHoldInput,
  ): Promise<{ holdsCreated: number; bookingsHeld: number }> => {
    if (this.failWith !== null) throw this.failWith;
    this.applied.push(input);
    return { holdsCreated: 1, bookingsHeld: 2 };
  };
}

function buildHandler(): {
  handler: BookingHoldRequestedHandler;
  holds: FakeSubjectHoldsService;
  logs: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const holds = new FakeSubjectHoldsService();
  const handler = new BookingHoldRequestedHandler(holds as unknown as SubjectHoldsService);
  const logger = (handler as unknown as { logger: Logger }).logger;
  const warn = vi.fn();
  const error = vi.fn();
  logger.warn = warn;
  logger.error = error;
  logger.log = vi.fn();
  return { handler, holds, logs: { warn, error } };
}

function args(
  payloadOverrides: Partial<HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_REQUESTED>['payload']> = {},
): HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_REQUESTED> {
  return {
    envelope: {
      eventId: 'evt_1',
      eventName: TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
      occurredAt: new Date(REQUESTED_AT),
      producerService: 'service-trust-safety',
      producerSchema: 'trust_safety',
    },
    payload: {
      eventId: 'evt_1',
      occurredAt: REQUESTED_AT,
      incidentId: 'inc_1',
      severity: 'critical',
      category: 'safety',
      providerId: 'prv_1',
      seniorId: null,
      householdId: 'hh_1',
      requestedAt: REQUESTED_AT,
      ...payloadOverrides,
    },
  } as unknown as HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_REQUESTED>;
}

describe('BookingHoldRequestedHandler', () => {
  it('applies the hold with the payload subjects and the SDK event id', async () => {
    const { handler, holds } = buildHandler();

    await handler.handle(args());

    expect(holds.applied).toHaveLength(1);
    expect(holds.applied[0]).toEqual({
      incidentId: 'inc_1',
      severity: 'critical',
      category: 'safety',
      providerId: 'prv_1',
      seniorId: null,
      householdId: 'hh_1',
      heldAt: new Date(REQUESTED_AT),
      // The relay-side envelope id, so the domain idempotency key matches
      // the SDK's dedup key exactly.
      sourceEventId: 'evt_1',
    });
  });

  it("stamps heldAt from the incident's clock, not the processing time", async () => {
    const { handler, holds } = buildHandler();
    const backfilled = '2026-07-01T08:00:00.000Z';

    await handler.handle(args({ requestedAt: backfilled }));

    expect(holds.applied[0]?.heldAt).toEqual(new Date(backfilled));
  });

  it('applies the hold for every severity it is handed — the predicate is not re-derived', async () => {
    // Trust & safety decides which concerns hold. A `medium` order arriving
    // here means the producer's policy changed, and the consumer must honour
    // it rather than second-guess it with a stale copy of the rule.
    for (const severity of ['low', 'medium', 'high', 'critical'] as const) {
      const { handler, holds } = buildHandler();
      await handler.handle(args({ severity }));
      expect(holds.applied).toHaveLength(1);
    }
  });

  it('logs the application at WARN — stopped care must be findable in the logs', async () => {
    const { handler, logs } = buildHandler();

    await handler.handle(args());

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[0]).toContain('booking.hold_requested.applied');
  });

  it('IGNORES a subjectless order rather than freezing the platform', async () => {
    const { handler, holds, logs } = buildHandler();

    await handler.handle(args({ providerId: null, seniorId: null, householdId: null }));

    expect(holds.applied).toHaveLength(0);
    // Permanent producer bug: logged at error and NOT retried, because
    // redelivering a malformed stop order ten times only buries the signal.
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls[0]?.[0]).toContain('booking.hold_requested.no_subject');
  });

  it('throws on a genuine failure so the SDK retries', async () => {
    const { handler, holds } = buildHandler();
    holds.failWith = new Error('postgres unavailable');

    await expect(handler.handle(args())).rejects.toThrow('postgres unavailable');
  });

  it('carries no free text into the hold — the payload has none to carry', async () => {
    const { handler, holds } = buildHandler();

    await handler.handle(args());

    expect(JSON.stringify(holds.applied[0])).not.toContain('description');
  });
});
