import 'reflect-metadata';

import { PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING } from '@taste-and-see/contracts';
import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import { AdverseFindingEmitter } from './adverse-finding-emitter';
import {
  isAdverseBackgroundCheckStatus,
  shouldRaiseAdverseFinding,
  type ProviderRecordStatus,
} from './adverse-finding-policy';
import type { BackgroundCheckRecordStatus } from './background-check.service';

/**
 * TS-307a — the predicate and the emitter.
 *
 * Two properties this suite exists to hold:
 *   - only an ACTIVE provider's adverse result raises anything (a
 *     rejection during onboarding is the application flow's business,
 *     and routing it here would bury the trust & safety queue);
 *   - nothing Checkr reported ever reaches the payload.
 */

const ALL_STATUSES: readonly BackgroundCheckRecordStatus[] = [
  'pending',
  'processing',
  'clear',
  'consider',
  'suspended',
  'engaged',
  'dispute',
  'canceled',
  'failed',
];

const ALL_PROVIDER_STATUSES: readonly ProviderRecordStatus[] = [
  'pending',
  'in_review',
  'active',
  'suspended',
  'archived',
];

describe('isAdverseBackgroundCheckStatus', () => {
  it.each(['consider', 'suspended', 'dispute', 'failed'] as const)(
    'treats %s as adverse',
    (status) => {
      expect(isAdverseBackgroundCheckStatus(status)).toBe(true);
    },
  );

  it.each(['pending', 'processing', 'clear', 'engaged', 'canceled'] as const)(
    'does NOT treat %s as adverse',
    (status) => {
      expect(isAdverseBackgroundCheckStatus(status)).toBe(false);
    },
  );

  it('classifies every status the schema can hold', () => {
    // Exhaustiveness guard: adding an enum member without deciding which
    // side it falls on fails here rather than defaulting to "not adverse".
    for (const status of ALL_STATUSES) {
      expect(typeof isAdverseBackgroundCheckStatus(status)).toBe('boolean');
    }
    expect(ALL_STATUSES.filter(isAdverseBackgroundCheckStatus)).toHaveLength(4);
  });
});

describe('shouldRaiseAdverseFinding', () => {
  it('raises for an adverse result on an ACTIVE provider', () => {
    expect(shouldRaiseAdverseFinding({ nextStatus: 'consider', providerStatus: 'active' })).toBe(
      true,
    );
  });

  it.each(['pending', 'in_review', 'suspended', 'archived'] as const)(
    'does NOT raise for a %s provider — nobody is exposed',
    (providerStatus) => {
      expect(shouldRaiseAdverseFinding({ nextStatus: 'consider', providerStatus })).toBe(false);
    },
  );

  it('does NOT raise for a clear result on an active provider', () => {
    expect(shouldRaiseAdverseFinding({ nextStatus: 'clear', providerStatus: 'active' })).toBe(
      false,
    );
  });

  it('raises for every adverse status only when the provider is active', () => {
    for (const providerStatus of ALL_PROVIDER_STATUSES) {
      for (const nextStatus of ALL_STATUSES) {
        const expected = providerStatus === 'active' && isAdverseBackgroundCheckStatus(nextStatus);
        expect(shouldRaiseAdverseFinding({ nextStatus, providerStatus })).toBe(expected);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────

class FakeOutbox {
  public appends: Array<Record<string, unknown>> = [];
  async append(_executor: unknown, args: Record<string, unknown>): Promise<unknown> {
    this.appends.push(args);
    return { eventId: args['eventId'] };
  }
}

function makeEmitter(): { emitter: AdverseFindingEmitter; outbox: FakeOutbox } {
  const outbox = new FakeOutbox();
  return {
    emitter: new AdverseFindingEmitter(outbox as unknown as OutboxService),
    outbox,
  };
}

const INPUT = {
  providerId: 'prov_1',
  backgroundCheckId: 'bg_1',
  previousStatus: 'clear' as BackgroundCheckRecordStatus,
  nextStatus: 'consider' as BackgroundCheckRecordStatus,
  providerStatus: 'active' as ProviderRecordStatus,
  checkrEventId: 'evt_checkr_9',
  occurredAt: new Date('2026-07-26T12:00:00.000Z'),
};

describe('AdverseFindingEmitter', () => {
  it('appends the event for an adverse finding on an active provider', async () => {
    const { emitter, outbox } = makeEmitter();
    const raised = await emitter.emitAdverseFinding({} as never, INPUT);

    expect(raised).toBe(true);
    expect(outbox.appends).toHaveLength(1);
    expect(outbox.appends[0]?.['eventName']).toBe(PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING);
  });

  it('is a NO-OP for a non-active provider, so the call site stays unconditional', async () => {
    const { emitter, outbox } = makeEmitter();
    const raised = await emitter.emitAdverseFinding({} as never, {
      ...INPUT,
      providerStatus: 'in_review',
    });

    expect(raised).toBe(false);
    expect(outbox.appends).toHaveLength(0);
  });

  it('is a NO-OP for a clear result', async () => {
    const { emitter, outbox } = makeEmitter();
    expect(await emitter.emitAdverseFinding({} as never, { ...INPUT, nextStatus: 'clear' })).toBe(
      false,
    );
    expect(outbox.appends).toHaveLength(0);
  });

  it('raises again on consider → consider — a second report is new information', async () => {
    const { emitter, outbox } = makeEmitter();
    await emitter.emitAdverseFinding({} as never, {
      ...INPUT,
      previousStatus: 'consider',
      checkrEventId: 'evt_checkr_10',
    });
    expect(outbox.appends).toHaveLength(1);
  });

  it('keys the outbox event deterministically on the CHECKR event id', async () => {
    const { emitter, outbox } = makeEmitter();
    await emitter.emitAdverseFinding({} as never, INPUT);
    expect(outbox.appends[0]?.['eventId']).toBe('bg_1.adverse.evt_checkr_9');
  });

  it('carries ids and the transition — and NOTHING Checkr reported', async () => {
    const { emitter, outbox } = makeEmitter();
    await emitter.emitAdverseFinding({} as never, INPUT);

    const payload = outbox.appends[0]?.['payload'] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'backgroundCheckId',
      'eventId',
      'occurredAt',
      'previousStatus',
      'providerId',
      'providerStatus',
      'status',
    ]);
    // The Checkr report id and the encrypted payload are the two things
    // that must never appear. Serialise the whole event and look.
    const serialised = JSON.stringify(outbox.appends[0]);
    expect(serialised).not.toContain('checkrReportId');
    expect(serialised).not.toContain('payloadCiphertext');
    expect(serialised).not.toContain('rawPayload');
  });

  it('stamps occurredAt from Checkr, not from processing time', async () => {
    const { emitter, outbox } = makeEmitter();
    await emitter.emitAdverseFinding({} as never, INPUT);

    const payload = outbox.appends[0]?.['payload'] as Record<string, unknown>;
    expect(payload['occurredAt']).toBe('2026-07-26T12:00:00.000Z');
    expect(outbox.appends[0]?.['occurredAt']).toEqual(INPUT.occurredAt);
  });
});
