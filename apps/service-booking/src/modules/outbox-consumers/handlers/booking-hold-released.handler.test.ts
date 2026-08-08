import type { Logger } from '@nestjs/common';
import { TRUST_SAFETY_BOOKING_HOLD_RELEASED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ReleaseSubjectHoldInput,
  ReleaseSubjectHoldResult,
  SubjectHoldsService,
} from '../../subject-holds/services/subject-holds.service';
import { BookingHoldReleasedHandler } from './booking-hold-released.handler';

const RELEASED_AT = '2026-07-27T09:00:00.000Z';

/** Records what the handler asked the hold service to do. */
class FakeSubjectHoldsService {
  readonly released: ReleaseSubjectHoldInput[] = [];
  result: ReleaseSubjectHoldResult = {
    holdsReleased: 1,
    bookingsCleared: 2,
    bookingsRestamped: 0,
  };
  failWith: Error | null = null;

  releaseSubjectHold = async (
    input: ReleaseSubjectHoldInput,
  ): Promise<ReleaseSubjectHoldResult> => {
    if (this.failWith !== null) throw this.failWith;
    this.released.push(input);
    return this.result;
  };
}

function buildHandler(): {
  handler: BookingHoldReleasedHandler;
  holds: FakeSubjectHoldsService;
  logs: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const holds = new FakeSubjectHoldsService();
  const handler = new BookingHoldReleasedHandler(holds as unknown as SubjectHoldsService);
  const logger = (handler as unknown as { logger: Logger }).logger;
  const log = vi.fn();
  const warn = vi.fn();
  logger.log = log;
  logger.warn = warn;
  logger.error = vi.fn();
  return { handler, holds, logs: { log, warn } };
}

function args(
  payloadOverrides: Partial<HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_RELEASED>['payload']> = {},
): HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_RELEASED> {
  return {
    envelope: {
      eventId: 'evt_rel_1',
      eventName: TRUST_SAFETY_BOOKING_HOLD_RELEASED,
      occurredAt: new Date(RELEASED_AT),
      producerService: 'service-trust-safety',
      producerSchema: 'trust_safety',
    },
    payload: {
      eventId: 'evt_rel_1',
      occurredAt: RELEASED_AT,
      incidentId: 'inc_1',
      severity: 'critical',
      category: 'safety',
      providerId: 'prv_1',
      seniorId: null,
      householdId: 'hh_1',
      releasedAt: RELEASED_AT,
      ...payloadOverrides,
    },
  } as unknown as HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_RELEASED>;
}

describe('BookingHoldReleasedHandler', () => {
  it('releases the hold with the payload subjects and the SDK event id', async () => {
    const { handler, holds } = buildHandler();

    await handler.handle(args());

    expect(holds.released).toEqual([
      {
        incidentId: 'inc_1',
        providerId: 'prv_1',
        seniorId: null,
        householdId: 'hh_1',
        // The committee's decision moment, from the event.
        releasedAt: new Date(RELEASED_AT),
        releaseEventId: 'evt_rel_1',
      },
    ]);
  });

  it('treats a release for a never-applied hold as a no-op, not a failure', async () => {
    // Reachable and expected: booking may have been down when the request was
    // published, or the request may have dead-lettered. Throwing would put the
    // release into an endless retry, and the suspension it exists to lift is
    // exactly what would stay stuck.
    const { handler, holds } = buildHandler();
    holds.result = { holdsReleased: 0, bookingsCleared: 0, bookingsRestamped: 0 };

    await expect(handler.handle(args())).resolves.toBeUndefined();
  });

  it('warns loudly when bookings stayed held by another open incident', async () => {
    const { handler, holds, logs } = buildHandler();
    holds.result = { holdsReleased: 1, bookingsCleared: 0, bookingsRestamped: 3 };

    await handler.handle(args());

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0]?.[0]).toContain('booking.hold_released.still_held');
  });

  it('does NOT warn when every booking was cleared', async () => {
    const { handler, logs } = buildHandler();

    await handler.handle(args());

    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.log).toHaveBeenCalledTimes(1);
    expect(logs.log.mock.calls[0]?.[0]).toContain('booking.hold_released.applied');
  });

  it('throws on a genuine failure so the SDK retries — a stuck release is a real harm', async () => {
    const { handler, holds } = buildHandler();
    holds.failWith = new Error('postgres unavailable');

    await expect(handler.handle(args())).rejects.toThrow('postgres unavailable');
  });
});
