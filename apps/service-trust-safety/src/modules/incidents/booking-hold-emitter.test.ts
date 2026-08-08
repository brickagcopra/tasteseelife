import { describe, expect, it } from 'vitest';
import {
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
  getEventSchema,
} from '@taste-and-see/contracts';
import type { EventName } from '@taste-and-see/contracts';
import type { OutboxService, OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { BookingHoldEmitFailedError, BookingHoldEmitter } from './booking-hold-emitter';
import type { IncidentRow } from './repositories/incident.repository';

const OPENED_AT = new Date('2026-07-26T10:00:00.000Z');
const RESOLVED_AT = new Date('2026-07-27T09:30:00.000Z');

/**
 * Fake outbox that validates against the REAL registry schema, exactly as
 * `OutboxService.append` does. That is the point of this suite: it proves the
 * payload the emitter builds is a payload the platform will accept, so a
 * contract edit breaks here rather than in production at 2am on a welfare
 * event. `rejectWith` forces the append-failed branch.
 */
class RegistryValidatingOutbox {
  readonly appended: { eventName: string; payload: Record<string, unknown> }[] = [];
  rejectWith: ReadonlyArray<{ path: readonly (string | number)[]; message: string }> | null = null;

  append = async (
    _tx: OutboxRawExecutor,
    args: { eventName: string; payload: unknown },
  ): Promise<
    | { kind: 'appended' }
    | {
        kind: 'validation_failed';
        eventName: string;
        issues: ReadonlyArray<{ path: readonly (string | number)[]; message: string }>;
      }
  > => {
    if (this.rejectWith !== null) {
      return { kind: 'validation_failed', eventName: args.eventName, issues: this.rejectWith };
    }
    const schema = getEventSchema(args.eventName as EventName);
    const parsed = schema.safeParse(args.payload);
    if (!parsed.success) {
      return {
        kind: 'validation_failed',
        eventName: args.eventName,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      };
    }
    this.appended.push({
      eventName: args.eventName,
      payload: args.payload as Record<string, unknown>,
    });
    return { kind: 'appended' };
  };
}

function buildEmitter(): { emitter: BookingHoldEmitter; outbox: RegistryValidatingOutbox } {
  const outbox = new RegistryValidatingOutbox();
  return {
    emitter: new BookingHoldEmitter(outbox as unknown as OutboxService),
    outbox,
  };
}

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: 'prv_1',
    reporterUserId: 'usr_1',
    source: 'family',
    category: 'welfare',
    severity: 'high',
    status: 'open',
    description: 'She has not eaten since Tuesday and the provider was two hours late.',
    openedAt: OPENED_AT,
    slaDueAt: new Date('2026-07-26T18:00:00.000Z'),
    resolvedAt: null,
    resolutionNotes: null,
    // TS-307a-followup-1 / TS-308c-followup-2 — the system-intake trail.
    // Null here: these fixtures are human-filed reports.
    sourceEventId: null,
    detector: null,
    systemFacts: null,
    createdAt: OPENED_AT,
    updatedAt: OPENED_AT,
    ...overrides,
  };
}

const TX = {} as OutboxRawExecutor;

describe('BookingHoldEmitter.emitHoldRequested', () => {
  it('appends a registry-valid payload for an eligible incident', async () => {
    const { emitter, outbox } = buildEmitter();

    await emitter.emitHoldRequested(TX, incident());

    expect(outbox.appended).toHaveLength(1);
    expect(outbox.appended[0]?.eventName).toBe(TRUST_SAFETY_BOOKING_HOLD_REQUESTED);
    expect(outbox.appended[0]?.payload).toMatchObject({
      incidentId: 'inc_1',
      severity: 'high',
      category: 'welfare',
      providerId: 'prv_1',
      seniorId: 'sen_1',
      householdId: 'hh_1',
      requestedAt: OPENED_AT.toISOString(),
    });
  });

  it("stamps requestedAt from the incident's own clock, not the publisher's", async () => {
    const { emitter, outbox } = buildEmitter();
    const backfilled = new Date('2026-07-01T08:00:00.000Z');

    await emitter.emitHoldRequested(TX, incident({ openedAt: backfilled }));

    expect(outbox.appended[0]?.payload['requestedAt']).toBe(backfilled.toISOString());
    // `occurredAt` is the publisher's — the two differ on a backfill.
    expect(outbox.appended[0]?.payload['occurredAt']).not.toBe(backfilled.toISOString());
  });

  it('carries NO free text — the filer description never rides the event', async () => {
    const { emitter, outbox } = buildEmitter();

    await emitter.emitHoldRequested(TX, incident());

    const serialised = JSON.stringify(outbox.appended[0]?.payload);
    expect(serialised).not.toContain('eaten');
    expect(serialised).not.toContain('description');
    expect(serialised).not.toContain('reporterUserId');
  });

  it('is a no-op below high severity', async () => {
    const { emitter, outbox } = buildEmitter();
    await emitter.emitHoldRequested(TX, incident({ severity: 'medium' }));
    expect(outbox.appended).toHaveLength(0);
  });

  it('is a no-op when the incident names no subject', async () => {
    const { emitter, outbox } = buildEmitter();
    await emitter.emitHoldRequested(
      TX,
      incident({ severity: 'critical', providerId: null, seniorId: null, householdId: null }),
    );
    expect(outbox.appended).toHaveLength(0);
  });

  it('throws BookingHoldEmitFailedError when the append is rejected', async () => {
    const { emitter, outbox } = buildEmitter();
    outbox.rejectWith = [{ path: ['severity'], message: 'nope' }];

    await expect(emitter.emitHoldRequested(TX, incident())).rejects.toBeInstanceOf(
      BookingHoldEmitFailedError,
    );
  });
});

describe('BookingHoldEmitter.emitHoldReleased', () => {
  it('appends a registry-valid release stamped with the resolution clock', async () => {
    const { emitter, outbox } = buildEmitter();

    await emitter.emitHoldReleased(
      TX,
      incident({ severity: 'critical', status: 'resolved', resolvedAt: RESOLVED_AT }),
      RESOLVED_AT,
    );

    expect(outbox.appended).toHaveLength(1);
    expect(outbox.appended[0]?.eventName).toBe(TRUST_SAFETY_BOOKING_HOLD_RELEASED);
    expect(outbox.appended[0]?.payload).toMatchObject({
      incidentId: 'inc_1',
      severity: 'critical',
      releasedAt: RESOLVED_AT.toISOString(),
    });
    // No `requestedAt` on the release half — the schema is `.strict()`.
    expect(outbox.appended[0]?.payload['requestedAt']).toBeUndefined();
  });

  it('carries the subject triple so the consumer can re-evaluate other holds', async () => {
    const { emitter, outbox } = buildEmitter();

    await emitter.emitHoldReleased(TX, incident({ seniorId: null }), RESOLVED_AT);

    expect(outbox.appended[0]?.payload).toMatchObject({
      providerId: 'prv_1',
      seniorId: null,
      householdId: 'hh_1',
    });
  });

  it('carries no resolution notes', async () => {
    const { emitter, outbox } = buildEmitter();

    await emitter.emitHoldReleased(
      TX,
      incident({ resolutionNotes: 'Unfounded — provider was at the wrong address.' }),
      RESOLVED_AT,
    );

    expect(JSON.stringify(outbox.appended[0]?.payload)).not.toContain('Unfounded');
  });

  it('is a no-op for an incident that was never hold-eligible', async () => {
    const { emitter, outbox } = buildEmitter();
    await emitter.emitHoldReleased(TX, incident({ severity: 'low' }), RESOLVED_AT);
    expect(outbox.appended).toHaveLength(0);
  });

  it('throws BookingHoldEmitFailedError when the append is rejected', async () => {
    const { emitter, outbox } = buildEmitter();
    outbox.rejectWith = [{ path: [], message: 'nope' }];

    await expect(emitter.emitHoldReleased(TX, incident(), RESOLVED_AT)).rejects.toBeInstanceOf(
      BookingHoldEmitFailedError,
    );
  });
});
