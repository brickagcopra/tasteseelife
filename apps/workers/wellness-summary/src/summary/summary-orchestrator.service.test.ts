import type {
  DispatchResponse,
  InternalSeniorWellnessObservationSummaryResponse,
  InternalWellnessSummaryHouseholdsResponse,
  RecipientContact,
  WellnessSummaryHousehold,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';

import type { DispatchClient } from './clients/dispatch.client';
import type { HouseholdsClient } from './clients/households.client';
import type { ObservationSummaryClient } from './clients/observation-summary.client';
import type { RecipientContactsClient } from './clients/recipient-contacts.client';
import type { ResolvedPeriod } from './schedule';
import { SummaryOrchestratorService } from './summary-orchestrator.service';

const PERIOD: ResolvedPeriod = { periodKey: '2026-05', periodLabel: 'April 2026' };

const ENV = {
  WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT: 100,
  WELLNESS_SUMMARY_WINDOW_DAYS: 30,
  WELLNESS_SUMMARY_APP_NAME: 'Taste & See',
} as unknown as Env;

function household(overrides?: Partial<WellnessSummaryHousehold>): WellnessSummaryHousehold {
  return {
    householdId: 'hh_1',
    seniors: [{ seniorId: 'snr_1', firstName: 'Rose', status: 'active', notesConsent: true }],
    recipients: [{ userId: 'usr_payer', role: 'primary_payer' }],
    ...overrides,
  };
}

function observation(): InternalSeniorWellnessObservationSummaryResponse {
  return {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 3,
    metrics: [{ metric: 'mood', latestScore: 4, averageScore: 4, visitsRecorded: 3 }],
    generatedAt: '2026-05-01T13:00:00.000Z',
  };
}

function contact(userId: string, status: RecipientContact['status'] = 'active'): RecipientContact {
  return { userId, email: `${userId}@example.com`, status };
}

function dispatchResult(over?: Partial<DispatchResponse>): DispatchResponse {
  return {
    id: 'disp_1',
    recipientUserId: 'usr_payer',
    channel: 'email',
    category: 'transactional',
    templateCode: 'wellness-summary-monthly',
    locale: 'en-US',
    templateVersionId: 'ver_1',
    recipientAddress: 'usr_payer@example.com',
    status: 'sent',
    suppressionReason: null,
    providerMessageId: 'pm_1',
    errorMessage: null,
    idempotencyKey: 'wellness-summary:2026-05:snr_1:usr_payer',
    sourceEventId: null,
    occurredAt: '2026-05-01T13:00:00.000Z',
    sentAt: '2026-05-01T13:00:00.000Z',
    replayed: false,
    ...over,
  };
}

interface Fakes {
  households: { fetchPage: ReturnType<typeof vi.fn> };
  contacts: { resolve: ReturnType<typeof vi.fn> };
  observations: { fetch: ReturnType<typeof vi.fn> };
  dispatch: { dispatch: ReturnType<typeof vi.fn> };
}

function makeOrchestrator(f: Partial<Fakes> = {}) {
  const pages: InternalWellnessSummaryHouseholdsResponse[] = [
    { households: [household()], nextCursor: null },
  ];
  const fakes: Fakes = {
    households: f.households ?? {
      fetchPage: vi.fn(async () => pages.shift() ?? { households: [], nextCursor: null }),
    },
    contacts: f.contacts ?? {
      resolve: vi.fn(async () => new Map([['usr_payer', contact('usr_payer')]])),
    },
    observations: f.observations ?? { fetch: vi.fn(async () => observation()) },
    dispatch: f.dispatch ?? { dispatch: vi.fn(async () => dispatchResult()) },
  };
  const orchestrator = new SummaryOrchestratorService(
    ENV,
    fakes.households as unknown as HouseholdsClient,
    fakes.contacts as unknown as RecipientContactsClient,
    fakes.observations as unknown as ObservationSummaryClient,
    fakes.dispatch as unknown as DispatchClient,
  );
  return { orchestrator, fakes };
}

describe('SummaryOrchestratorService.runForPeriod', () => {
  it('dispatches one email per (senior × active recipient)', async () => {
    const { orchestrator, fakes } = makeOrchestrator();
    const report = await orchestrator.runForPeriod(PERIOD);

    expect(fakes.dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(report.householdsProcessed).toBe(1);
    expect(report.seniorsSummarised).toBe(1);
    expect(report.dispatchesSent).toBe(1);
  });

  it('walks every page until nextCursor is null', async () => {
    const pages: InternalWellnessSummaryHouseholdsResponse[] = [
      { households: [household({ householdId: 'hh_1' })], nextCursor: 'hh_1' },
      { households: [household({ householdId: 'hh_2' })], nextCursor: null },
    ];
    const fetchPage = vi.fn(async () => pages.shift() ?? { households: [], nextCursor: null });
    const { orchestrator, fakes } = makeOrchestrator({ households: { fetchPage } });

    const report = await orchestrator.runForPeriod(PERIOD);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(report.householdsProcessed).toBe(2);
    expect(fakes.dispatch.dispatch).toHaveBeenCalledTimes(2);
  });

  it('skips a household when recipient-contact resolution fails', async () => {
    const { orchestrator, fakes } = makeOrchestrator({
      contacts: { resolve: vi.fn(async () => Promise.reject(new Error('identity down'))) },
    });
    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.householdsSkipped).toBe(1);
    expect(report.householdsProcessed).toBe(0);
    expect(fakes.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('skips a senior when its observation fetch fails but still processes the household', async () => {
    const { orchestrator, fakes } = makeOrchestrator({
      observations: { fetch: vi.fn(async () => Promise.reject(new Error('booking down'))) },
    });
    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.seniorsSkipped).toBe(1);
    expect(report.seniorsSummarised).toBe(0);
    expect(report.householdsProcessed).toBe(1);
    expect(fakes.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('skips a recipient with no contact or a non-active account', async () => {
    const hh = household({
      recipients: [
        { userId: 'usr_active', role: 'primary_payer' },
        { userId: 'usr_suspended', role: 'family_observer' },
        { userId: 'usr_missing', role: 'family_observer' },
      ],
    });
    const { orchestrator, fakes } = makeOrchestrator({
      households: { fetchPage: vi.fn(async () => ({ households: [hh], nextCursor: null })) },
      contacts: {
        resolve: vi.fn(
          async () =>
            new Map([
              ['usr_active', contact('usr_active', 'active')],
              ['usr_suspended', contact('usr_suspended', 'suspended')],
              // usr_missing intentionally absent
            ]),
        ),
      },
    });
    const report = await orchestrator.runForPeriod(PERIOD);

    expect(fakes.dispatch.dispatch).toHaveBeenCalledTimes(1); // only usr_active
    expect(report.recipientsSkipped).toBe(2);
    expect(report.dispatchesSent).toBe(1);
  });

  it('counts a failed dispatch without aborting the run', async () => {
    const hh = household({
      recipients: [
        { userId: 'usr_a', role: 'primary_payer' },
        { userId: 'usr_b', role: 'family_observer' },
      ],
    });
    let call = 0;
    const { orchestrator } = makeOrchestrator({
      households: { fetchPage: vi.fn(async () => ({ households: [hh], nextCursor: null })) },
      contacts: {
        resolve: vi.fn(
          async () =>
            new Map([
              ['usr_a', contact('usr_a')],
              ['usr_b', contact('usr_b')],
            ]),
        ),
      },
      dispatch: {
        dispatch: vi.fn(async () => {
          call += 1;
          if (call === 1) throw new Error('notification 500');
          return dispatchResult();
        }),
      },
    });
    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.dispatchesFailed).toBe(1);
    expect(report.dispatchesSent).toBe(1);
  });

  it('counts a replayed dispatch separately from a fresh send', async () => {
    const { orchestrator } = makeOrchestrator({
      dispatch: { dispatch: vi.fn(async () => dispatchResult({ replayed: true })) },
    });
    const report = await orchestrator.runForPeriod(PERIOD);
    expect(report.dispatchesReplayed).toBe(1);
    expect(report.dispatchesSent).toBe(0);
  });
});
