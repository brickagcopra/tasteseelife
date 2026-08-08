import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { ApplicationsMetrics } from './applications-metrics';
import {
  ApplicationsService,
  type ApplicationRecord,
  type ApplicationStatus,
  type ProviderRecord,
  type ProviderStatus,
} from './applications.service';
import {
  BackgroundCheckService,
  type BackgroundCheckRecord,
  type BackgroundCheckRecordStatus,
} from './background-check.service';
import { err, ok } from './result';

type FakeProviderRow = {
  id: string;
  userId: string;
  status: ProviderStatus;
  tier: 'basic' | 'certified' | 'elite';
  displayName: string;
  headline: string | null;
  bio: string | null;
  profilePhotoKey: string | null;
  videoIntroKey: string | null;
  timeZone: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type FakeApplicationRow = {
  id: string;
  providerId: string;
  status: ApplicationStatus;
  applicantNotes: string | null;
  reviewerUserId: string | null;
  reviewNotes: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakePrisma {
  providers: FakeProviderRow[] = [];
  applications: FakeApplicationRow[] = [];
  private provCounter = 0;
  private appCounter = 0;

  provider = {
    findUnique: vi.fn(async (args: { where: { userId: string } }) => {
      return this.providers.find((p) => p.userId === args.where.userId) ?? null;
    }),
    create: vi.fn(async (args: { data: Partial<FakeProviderRow> }) => {
      this.provCounter += 1;
      const now = new Date();
      const row: FakeProviderRow = {
        id: `prov_${this.provCounter}`,
        userId: args.data.userId ?? '',
        status: (args.data.status ?? 'pending') as ProviderStatus,
        tier: 'basic',
        displayName: args.data.displayName ?? '',
        headline: args.data.headline ?? null,
        bio: args.data.bio ?? null,
        profilePhotoKey: null,
        videoIntroKey: null,
        timeZone: args.data.timeZone ?? 'America/New_York',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.providers.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<FakeProviderRow> }) => {
      const row = this.providers.find((p) => p.id === args.where.id);
      if (!row) throw new Error(`provider not found: ${args.where.id}`);
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    }),
  };

  providerApplication = {
    findFirst: vi.fn(
      async (args: {
        where: { providerId: string; status?: { in: string[] } };
        orderBy?: { submittedAt: 'asc' | 'desc' };
      }) => {
        let matches = this.applications.filter((a) => a.providerId === args.where.providerId);
        if (args.where.status?.in) {
          const statuses = new Set(args.where.status.in);
          matches = matches.filter((a) => statuses.has(a.status));
        }
        if (matches.length === 0) return null;
        const order = args.orderBy?.submittedAt ?? 'asc';
        matches.sort((a, b) =>
          order === 'desc'
            ? b.submittedAt.getTime() - a.submittedAt.getTime()
            : a.submittedAt.getTime() - b.submittedAt.getTime(),
        );
        return matches[0] ?? null;
      },
    ),
    create: vi.fn(async (args: { data: Partial<FakeApplicationRow> }) => {
      this.appCounter += 1;
      const now = new Date();
      const row: FakeApplicationRow = {
        id: `app_${this.appCounter}`,
        providerId: args.data.providerId ?? '',
        status: (args.data.status ?? 'submitted') as ApplicationStatus,
        applicantNotes: args.data.applicantNotes ?? null,
        reviewerUserId: null,
        reviewNotes: null,
        submittedAt: now,
        reviewedAt: null,
        withdrawnAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.applications.push(row);
      return row;
    }),
  };
}

class FakeBackgroundCheckService {
  startResponses: Array<Awaited<ReturnType<BackgroundCheckService['startCheck']>>> = [];
  latestResponses: BackgroundCheckRecord[] = [];
  startCalls: Array<Record<string, unknown>> = [];

  async startCheck(input: Record<string, unknown>) {
    this.startCalls.push(input);
    return (
      this.startResponses.shift() ??
      ok<BackgroundCheckRecord>({
        id: 'bg_1',
        providerId: String(input['providerId']),
        applicationId: String(input['applicationId']),
        status: 'pending' as BackgroundCheckRecordStatus,
        checkrCandidateId: 'cand_default',
        checkrReportId: 'rep_default',
        lastEventId: null,
        completedAt: null,
        payloadCiphertext: null,
        payloadIv: null,
        payloadAuthTag: null,
        payloadKeyVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
  }

  async getLatestForProvider(providerId: string) {
    return this.latestResponses.find((r) => r.providerId === providerId) ?? null;
  }
}

function makeService(): {
  prisma: FakePrisma;
  bg: FakeBackgroundCheckService;
  service: ApplicationsService;
} {
  const prisma = new FakePrisma();
  const bg = new FakeBackgroundCheckService();
  const service = new ApplicationsService(
    prisma as unknown as PrismaService,
    bg as unknown as BackgroundCheckService,
  );
  return { prisma, bg, service };
}

const APPLICANT = {
  firstName: 'Sam',
  lastName: 'Cook',
  email: 'sam@example.com',
  phone: '+15551234567',
  dob: '1980-05-12',
  zipcode: '10021',
};

const PROFILE = {
  displayName: 'Chef Sam',
  timeZone: 'America/New_York',
  headline: 'Comfort-food specialist',
};

describe('ApplicationsService.submitApplication', () => {
  it('creates provider + application + background check on first submission', async () => {
    const { service, prisma, bg } = makeService();
    const result = await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(true);
    expect(prisma.providers).toHaveLength(1);
    expect(prisma.providers[0]?.userId).toBe('user_1');
    expect(prisma.providers[0]?.status).toBe('in_review');
    expect(prisma.providers[0]?.displayName).toBe('Chef Sam');
    expect(prisma.applications).toHaveLength(1);
    expect(prisma.applications[0]?.status).toBe('submitted');
    expect(bg.startCalls).toHaveLength(1);
    expect(bg.startCalls[0]?.['providerId']).toBe(prisma.providers[0]?.id);
  });

  it('forwards applicantNotes onto the application row', async () => {
    const { service, prisma } = makeService();
    await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
      applicantNotes: 'I worked at Daniel for six years.',
    });
    expect(prisma.applications[0]?.applicantNotes).toBe('I worked at Daniel for six years.');
  });

  it('forwards the idempotencyKey to the background-check service', async () => {
    const { service, bg } = makeService();
    await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
      idempotencyKey: 'top-level-key',
    });
    expect(bg.startCalls[0]?.['idempotencyKey']).toBe('top-level-key');
  });

  it('returns invalid_request when userId is empty', async () => {
    const { service } = makeService();
    const result = await service.submitApplication({
      userId: '',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns invalid_request when displayName is empty', async () => {
    const { service } = makeService();
    const result = await service.submitApplication({
      userId: 'user_1',
      profile: { ...PROFILE, displayName: '' },
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns already_applied when an active (submitted) application exists for the user', async () => {
    const { service } = makeService();
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });
    const second = await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.reason).toBe('already_applied');
      if (second.error.reason === 'already_applied') {
        expect(second.error.applicationId).toMatch(/^app_/);
      }
    }
  });

  it('translates a background-check failure into the same failure shape', async () => {
    const { service, bg } = makeService();
    bg.startResponses.push(err({ reason: 'checkr_unavailable', cause: new Error('x') }));
    const result = await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('checkr_unavailable');
    }
  });

  it('leaves the provider + application rows in place when background-check fails', async () => {
    const { service, bg, prisma } = makeService();
    bg.startResponses.push(err({ reason: 'checkr_unavailable', cause: new Error('x') }));
    await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(prisma.providers).toHaveLength(1);
    expect(prisma.applications).toHaveLength(1);
  });

  it('updates an existing provider row instead of creating a duplicate', async () => {
    const { service, prisma } = makeService();
    // Seed an existing provider row in `pending` (no active app).
    prisma.providers.push({
      id: 'prov_seed',
      userId: 'user_1',
      status: 'pending',
      tier: 'basic',
      displayName: 'Old Name',
      headline: null,
      bio: null,
      profilePhotoKey: null,
      videoIntroKey: null,
      timeZone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    expect(prisma.providers).toHaveLength(1);
    expect(prisma.providers[0]?.id).toBe('prov_seed');
    expect(prisma.providers[0]?.status).toBe('in_review');
    expect(prisma.providers[0]?.displayName).toBe('Chef Sam');
    expect(prisma.providers[0]?.timeZone).toBe('America/New_York');
  });
});

describe('ApplicationsService.getLatestForUser', () => {
  it('returns null/null/null when nothing exists', async () => {
    const { service } = makeService();
    const result = await service.getLatestForUser('user_1');
    expect(result.provider).toBeNull();
    expect(result.application).toBeNull();
    expect(result.backgroundCheck).toBeNull();
  });

  it('returns the provider + latest application + background check when present', async () => {
    const { service, bg } = makeService();
    bg.latestResponses.push({
      id: 'bg_1',
      providerId: 'prov_1',
      applicationId: 'app_1',
      status: 'clear' as BackgroundCheckRecordStatus,
      checkrCandidateId: 'cand_abc',
      checkrReportId: 'rep_abc',
      lastEventId: 'evt_1',
      completedAt: new Date('2026-05-11T12:00:00Z'),
      payloadCiphertext: null,
      payloadIv: null,
      payloadAuthTag: null,
      payloadKeyVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.submitApplication({
      userId: 'user_1',
      profile: PROFILE,
      applicant: APPLICANT,
    });
    // The fake bg.startCheck creates a fresh response but
    // getLatestForProvider reads from latestResponses; we override
    // the providerId on the seeded latest entry below.
    const { provider } = await service.getLatestForUser('user_1');
    expect(provider).not.toBeNull();
    if (bg.latestResponses[0]) {
      bg.latestResponses[0] = {
        ...bg.latestResponses[0],
        providerId: provider?.id ?? '',
      } as Awaited<
        ReturnType<BackgroundCheckService['getLatestForProvider']>
      > as BackgroundCheckRecord;
    }
    const result = await service.getLatestForUser('user_1');
    expect(result.provider?.userId).toBe('user_1');
    expect(result.application?.status).toBe('submitted');
    expect(result.backgroundCheck?.status).toBe('clear');
  });

  it('returns null/null/null for an empty userId', async () => {
    const { service } = makeService();
    const result = await service.getLatestForUser('');
    expect(result.provider).toBeNull();
    expect(result.application).toBeNull();
    expect(result.backgroundCheck).toBeNull();
  });
});

/**
 * Observability wiring (TS-051-followup-7). A real MeterProvider is booted
 * so the `ApplicationsMetrics` constructed here binds to the live meter; the
 * service drives each outcome end-to-end and the Prometheus exposition is
 * asserted. Mirrors the KycService observability block.
 */
describe('ApplicationsService — observability', () => {
  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  function makeServiceWithMetrics(): {
    prisma: FakePrisma;
    bg: FakeBackgroundCheckService;
    service: ApplicationsService;
  } {
    const prisma = new FakePrisma();
    const bg = new FakeBackgroundCheckService();
    const service = new ApplicationsService(
      prisma as unknown as PrismaService,
      bg as unknown as BackgroundCheckService,
      new ApplicationsMetrics(),
    );
    return { prisma, bg, service };
  }

  it('counts a successful submission as outcome="ok"', async () => {
    const { service } = makeServiceWithMetrics();
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });

    const out = await serializeMetrics();
    expect(out).toMatch(/provider_applications_submitted_total\{[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('counts a checkr_unavailable failure with the matching outcome', async () => {
    const { service, bg } = makeServiceWithMetrics();
    bg.startResponses.push(err({ reason: 'checkr_unavailable', cause: new Error('down') }));
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_applications_submitted_total\{[^}]*outcome="checkr_unavailable"[^}]*\} 1/,
    );
  });

  it('counts an already-applied submission as outcome="already_applied"', async () => {
    const { service } = makeServiceWithMetrics();
    // First submission opens an active application…
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });
    // …the second sees the active application and short-circuits.
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_applications_submitted_total\{[^}]*outcome="already_applied"[^}]*\} 1/,
    );
  });

  it('never leaks a userId / candidate / report id onto the scrape surface', async () => {
    const { service } = makeServiceWithMetrics();
    await service.submitApplication({ userId: 'user_1', profile: PROFILE, applicant: APPLICANT });

    const out = await serializeMetrics();
    expect(out).not.toContain('user_1');
    expect(out).not.toContain('cand_');
    expect(out).not.toContain('rep_');
    expect(out).toMatch(/provider_applications_submitted_total/);
  });
});

// Reference the unused type imports so the file compiles cleanly
// under noUnusedParameters / unused-import lint.
void (null as unknown as ProviderRecord);
void (null as unknown as ApplicationRecord);
