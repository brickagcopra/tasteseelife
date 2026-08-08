import { describe, expect, it } from 'vitest';

import {
  Provider360IncidentsSectionSchema,
  Provider360IncidentsUnavailableReasonSchema,
  Provider360ResponseSchema,
} from '../http/provider-360.schema';

/**
 * Contract tests for the composed Provider 360 (TS-305b).
 *
 * The assertion that matters most: "no incidents" and "could not ask"
 * must be structurally distinguishable. A committee reading an empty
 * section as a clean record when trust-safety was actually down is the
 * failure this shape exists to prevent, so the union is asserted from
 * both sides — an `available` section cannot carry a `reason`, and an
 * `unavailable` section cannot carry rows.
 */

const CORE = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Amara',
  headline: null,
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  dementiaSensitive: false,
  languages: [],
  cuisines: [],
  dietaryExpertise: [],
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-05-19T10:00:00.000Z',
  deletedAt: null,
} as const;

const INCIDENT = {
  id: 'inc_1',
  source: 'family',
  category: 'welfare',
  severity: 'high',
  status: 'triaging',
  householdId: 'hh_1',
  seniorId: 'sen_1',
  providerId: 'prov_1',
  reporterUserId: 'usr_9',
  openedAt: '2026-07-20T10:00:00.000Z',
  slaDueAt: '2026-07-20T18:00:00.000Z',
  resolvedAt: null,
  hasMandatedReporterCase: false,
} as const;

const METRICS = {
  lifetime: { state: 'no_activity' },
  recent: { state: 'no_activity' },
  windowDays: 90,
  firstObservedAt: null,
  lastObservedAt: null,
  computedAt: '2026-07-26T12:00:00.000Z',
} as const;

const RESPONSE = {
  provider: CORE,
  certifications: [],
  tierHistory: [],
  backgroundCheck: null,
  metrics: METRICS,
  incidents: { state: 'available', incidents: [INCIDENT], truncated: false },
  generatedAt: '2026-07-26T12:00:00.000Z',
} as const;

describe('Provider360IncidentsSectionSchema', () => {
  it('accepts a populated available section', () => {
    const parsed = Provider360IncidentsSectionSchema.parse(RESPONSE.incidents);
    expect(parsed.state).toBe('available');
  });

  it('accepts an EMPTY available section — a clean record', () => {
    const parsed = Provider360IncidentsSectionSchema.parse({
      state: 'available',
      incidents: [],
      truncated: false,
    });
    expect(parsed).toEqual({ state: 'available', incidents: [], truncated: false });
  });

  it.each(['not_configured', 'unreachable', 'timeout', 'upstream_error', 'contract_drift'])(
    'accepts an unavailable section with reason %s',
    (reason) => {
      const parsed = Provider360IncidentsSectionSchema.parse({ state: 'unavailable', reason });
      expect(parsed.state).toBe('unavailable');
    },
  );

  it('rejects an unavailable section carrying rows — the states must not blur', () => {
    expect(
      Provider360IncidentsSectionSchema.safeParse({
        state: 'unavailable',
        reason: 'timeout',
        incidents: [INCIDENT],
      }).success,
    ).toBe(false);
  });

  it('rejects an available section carrying a reason', () => {
    expect(
      Provider360IncidentsSectionSchema.safeParse({
        state: 'available',
        incidents: [],
        truncated: false,
        reason: 'timeout',
      }).success,
    ).toBe(false);
  });

  it('requires truncated on an available section — silence about dropped rows is not an option', () => {
    expect(
      Provider360IncidentsSectionSchema.safeParse({ state: 'available', incidents: [] }).success,
    ).toBe(false);
  });

  it('rejects a null incidents section — absence must carry a reason', () => {
    expect(Provider360IncidentsSectionSchema.safeParse(null).success).toBe(false);
  });

  it('rejects an unknown unavailable reason', () => {
    expect(Provider360IncidentsUnavailableReasonSchema.safeParse('forbidden').success).toBe(false);
  });
});

describe('Provider360ResponseSchema', () => {
  it('accepts a fully-composed response', () => {
    const parsed = Provider360ResponseSchema.parse(RESPONSE);
    expect(parsed.provider.id).toBe('prov_1');
    expect(parsed.incidents.state).toBe('available');
  });

  it('accepts a response whose incident section is unavailable', () => {
    const parsed = Provider360ResponseSchema.parse({
      ...RESPONSE,
      incidents: { state: 'unavailable', reason: 'unreachable' },
    });
    expect(parsed.incidents).toEqual({ state: 'unavailable', reason: 'unreachable' });
  });

  it('accepts a truncated incident history', () => {
    const parsed = Provider360ResponseSchema.parse({
      ...RESPONSE,
      incidents: { state: 'available', incidents: [INCIDENT], truncated: true },
    });
    expect(parsed.incidents).toMatchObject({ truncated: true });
  });

  it('requires the incident section — a missing section is not a degraded one', () => {
    const { incidents: _dropped, ...withoutIncidents } = RESPONSE;
    expect(Provider360ResponseSchema.safeParse(withoutIncidents).success).toBe(false);
  });

  it('requires the provider core — the dossier is fatal, never partial', () => {
    const { provider: _dropped, ...withoutProvider } = RESPONSE;
    expect(Provider360ResponseSchema.safeParse(withoutProvider).success).toBe(false);
  });

  it.each(['rating', 'completionRate', 'providerLinkageIncomplete'])(
    'rejects the unmodelled field %s',
    (field) => {
      expect(Provider360ResponseSchema.safeParse({ ...RESPONSE, [field]: true }).success).toBe(
        false,
      );
    },
  );

  it('carries the admin-only userId through composition', () => {
    const parsed = Provider360ResponseSchema.parse(RESPONSE);
    expect(parsed.provider.userId).toBe('usr_1');
  });
});
