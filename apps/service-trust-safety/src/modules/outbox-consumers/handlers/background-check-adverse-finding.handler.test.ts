import type { Logger } from '@nestjs/common';
import { PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateIncidentInput,
  IncidentsService,
} from '../../incidents/services/incidents.service';

import {
  BackgroundCheckAdverseFindingHandler,
  gradeAdverseFinding,
} from './background-check-adverse-finding.handler';

/**
 * TS-307a — trust & safety's first outbox-consumer handler.
 *
 * The properties that matter:
 *   - the incident carries the event id as its idempotency key, and a
 *     P2002 on that key is "already opened", not a failure to retry;
 *   - severity is graded HERE, and `dispute` is graded lower than a
 *     fresh finding on purpose;
 *   - the incident has NO description — the report never left
 *     service-provider;
 *   - anything other than a duplicate throws, so the SDK redelivers.
 */

const OCCURRED_AT = '2026-07-26T12:00:00.000Z';

class FakeIncidentsService {
  readonly created: CreateIncidentInput[] = [];
  failWith: unknown = null;

  createIncident = async (input: CreateIncidentInput): Promise<{ id: string }> => {
    if (this.failWith !== null) throw this.failWith;
    this.created.push(input);
    return { id: `inc_${this.created.length}` };
  };
}

function buildHandler(): {
  handler: BackgroundCheckAdverseFindingHandler;
  incidents: FakeIncidentsService;
  logs: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const incidents = new FakeIncidentsService();
  const handler = new BackgroundCheckAdverseFindingHandler(
    incidents as unknown as IncidentsService,
  );
  const logger = (handler as unknown as { logger: Logger }).logger;
  const log = vi.fn();
  const warn = vi.fn();
  logger.log = log;
  logger.warn = warn;
  logger.error = vi.fn();
  return { handler, incidents, logs: { log, warn } };
}

function args(
  overrides: Partial<HandleArgs<typeof PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING>['payload']> = {},
  eventId = 'bg_1.adverse.evt_9',
): HandleArgs<typeof PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING> {
  return {
    envelope: {
      eventId,
      eventName: PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
      occurredAt: new Date(OCCURRED_AT),
      producerService: 'service-provider',
      producerSchema: 'provider',
    },
    payload: {
      eventId,
      occurredAt: OCCURRED_AT,
      providerId: 'prov_1',
      backgroundCheckId: 'bg_1',
      previousStatus: 'clear',
      status: 'consider',
      providerStatus: 'active',
      ...overrides,
    },
  } as unknown as HandleArgs<typeof PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING>;
}

describe('gradeAdverseFinding', () => {
  it.each(['consider', 'suspended', 'failed'] as const)('grades %s as high', (status) => {
    expect(gradeAdverseFinding(status)).toBe('high');
  });

  it('grades dispute as MEDIUM — a contested finding is not new risk information', () => {
    // Grading it `high` would re-suspend a provider's bookings (TS-304) for
    // exercising a statutory right to contest.
    expect(gradeAdverseFinding('dispute')).toBe('medium');
  });

  it('never grades an adverse finding critical — critical pages on-call at 3am', () => {
    for (const status of ['consider', 'suspended', 'dispute', 'failed'] as const) {
      expect(gradeAdverseFinding(status)).not.toBe('critical');
    }
  });
});

describe('BackgroundCheckAdverseFindingHandler', () => {
  it('opens a system-sourced safety incident against the provider', async () => {
    const { handler, incidents } = buildHandler();
    await handler.handle(args());

    expect(incidents.created).toHaveLength(1);
    expect(incidents.created[0]).toMatchObject({
      source: 'system',
      category: 'safety',
      severity: 'high',
      providerId: 'prov_1',
    });
  });

  it('records the categorical status as system evidence, never the finding (TS-308c-followup-2)', async () => {
    // Until this landed, an operator opening one of these saw a
    // category, a severity, a provider and nothing else. What Checkr
    // REPORTED still does not appear here — only the status that graded
    // it, which is all that ever crossed the service boundary.
    const { handler, incidents } = buildHandler();
    await handler.handle(args());

    expect(incidents.created[0]?.evidence).toMatchObject({
      detector: 'background_check',
      status: 'consider',
    });
  });

  it('keys the incident on the EVENT id — the domain idempotency guard', async () => {
    const { handler, incidents } = buildHandler();
    await handler.handle(args({}, 'bg_7.adverse.evt_42'));

    expect(incidents.created[0]?.sourceEventId).toBe('bg_7.adverse.evt_42');
  });

  it('opens the incident with NO description — the report never left service-provider', async () => {
    const { handler, incidents } = buildHandler();
    await handler.handle(args());

    expect(incidents.created[0]?.description).toBeUndefined();
    expect(incidents.created[0]?.reporterUserId).toBeUndefined();
  });

  it('grades a dispute lower than a fresh finding', async () => {
    const { handler, incidents } = buildHandler();
    await handler.handle(args({ status: 'dispute' }));

    expect(incidents.created[0]?.severity).toBe('medium');
  });

  it('treats a P2002 on the source event id as ALREADY OPENED, not a failure', async () => {
    const { handler, incidents, logs } = buildHandler();
    incidents.failWith = Object.assign(new Error('unique violation'), { code: 'P2002' });

    await expect(handler.handle(args())).resolves.toBeUndefined();
    expect(logs.log).toHaveBeenCalled();
  });

  it('RETHROWS anything else so the SDK redelivers', async () => {
    // A dropped finding means a provider keeps visiting seniors with nobody
    // having read their report. It must stay in the PEL.
    const { handler, incidents } = buildHandler();
    incidents.failWith = new Error('database is on fire');

    await expect(handler.handle(args())).rejects.toThrow('database is on fire');
  });

  it('logs the opened incident at WARN, carrying ids and statuses only', async () => {
    const { handler, logs } = buildHandler();
    await handler.handle(args());

    expect(logs.warn).toHaveBeenCalledTimes(1);
    const line = String(logs.warn.mock.calls[0]?.[0]);
    expect(line).toContain('prov_1');
    expect(line).toContain('bg_1');
    expect(line).toContain('"status":"consider"');
    // Nothing Checkr reported can appear, because none of it is in scope here.
    expect(line).not.toContain('rawPayload');
  });
});
