import {
  WELLNESS_SUMMARY_TEMPLATE_CODE,
  WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES,
  type InternalSeniorWellnessObservationSummaryResponse,
  type WellnessSummaryRecipient,
  type WellnessSummarySenior,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { buildDispatchRequest, recipientMaySeeDetail } from './variable-builder';

const senior: WellnessSummarySenior = {
  seniorId: 'snr_1',
  firstName: 'Rose',
  status: 'active',
  notesConsent: false,
};

const observation: InternalSeniorWellnessObservationSummaryResponse = {
  seniorId: 'snr_1',
  windowDays: 30,
  totalCompletedVisits: 4,
  metrics: [
    { metric: 'mood', latestScore: 4, averageScore: 3.8, visitsRecorded: 4 },
    { metric: 'appetite', latestScore: 3, averageScore: 3.5, visitsRecorded: 2 },
    { metric: 'hydration', latestScore: null, averageScore: null, visitsRecorded: 0 },
    { metric: 'social_engagement', latestScore: 5, averageScore: 4.0, visitsRecorded: 1 },
  ],
  generatedAt: '2026-05-01T13:00:00.000Z',
};

function build(
  recipient: WellnessSummaryRecipient,
  seniorOverride?: Partial<WellnessSummarySenior>,
) {
  return buildDispatchRequest({
    recipient,
    recipientEmail: 'rose.family@example.com',
    senior: { ...senior, ...seniorOverride },
    observation,
    periodKey: '2026-05',
    periodLabel: 'April 2026',
    appName: 'Taste & See',
  });
}

describe('recipientMaySeeDetail', () => {
  it('always grants the primary payer + senior user', () => {
    expect(recipientMaySeeDetail('primary_payer', false)).toBe(true);
    expect(recipientMaySeeDetail('senior_user', false)).toBe(true);
  });

  it('gates the family observer on notes consent', () => {
    expect(recipientMaySeeDetail('family_observer', false)).toBe(false);
    expect(recipientMaySeeDetail('family_observer', true)).toBe(true);
  });
});

describe('buildDispatchRequest', () => {
  it('targets the shared template + email channel + transactional category', () => {
    const req = build({ userId: 'usr_1', role: 'primary_payer' });
    expect(req.templateCode).toBe(WELLNESS_SUMMARY_TEMPLATE_CODE);
    expect(req.channel).toBe('email');
    expect(req.category).toBe('transactional');
    expect(req.locale).toBe('en-US');
    expect(req.recipientAddress).toBe('rose.family@example.com');
  });

  it('supplies every declared template variable', () => {
    const req = build({ userId: 'usr_1', role: 'primary_payer' });
    const keys = Object.keys(req.variables ?? {}).sort();
    expect(keys).toEqual([...WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES].sort());
  });

  it('builds a deterministic idempotency key per (period, senior, recipient)', () => {
    const req = build({ userId: 'usr_9', role: 'primary_payer' });
    expect(req.idempotencyKey).toBe('wellness-summary:2026-05:snr_1:usr_9');
    expect(req.idempotencyKey.length).toBeGreaterThanOrEqual(16);
  });

  it('renders scale roll-ups for a recipient who may see detail', () => {
    const req = build({ userId: 'usr_1', role: 'primary_payer' });
    expect(req.variables?.['detailShared']).toBe(true);
    expect(req.variables?.['moodSummary']).toBe('Mood: 3.8 / 5 on average across 4 visits.');
    expect(req.variables?.['appetiteSummary']).toBe(
      'Appetite: 3.5 / 5 on average across 2 visits.',
    );
    expect(req.variables?.['hydrationSummary']).toBe('Hydration: not recorded this period.');
    expect(req.variables?.['socialSummary']).toBe(
      'Social engagement: 4 / 5 on average across 1 visit.',
    );
    expect(req.variables?.['totalVisits']).toBe(4);
  });

  it('withholds detail (empty scale strings) for an observer without notes consent', () => {
    const req = build({ userId: 'usr_2', role: 'family_observer' }, { notesConsent: false });
    expect(req.variables?.['detailShared']).toBe(false);
    expect(req.variables?.['moodSummary']).toBe('');
    expect(req.variables?.['appetiteSummary']).toBe('');
    // The visit count is NOT detail — still shown.
    expect(req.variables?.['totalVisits']).toBe(4);
  });

  it('shares detail with an observer once the senior shares notes', () => {
    const req = build({ userId: 'usr_2', role: 'family_observer' }, { notesConsent: true });
    expect(req.variables?.['detailShared']).toBe(true);
    expect(req.variables?.['moodSummary']).toContain('Mood:');
  });
});
