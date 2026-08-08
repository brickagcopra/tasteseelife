import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ConciergeEnrichmentSummaryRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  EnrichmentService,
  type CreateSummaryOutcome,
  type UpdateSummaryOutcome,
} from '../services/enrichment.service';
import { EnrichmentController } from './enrichment.controller';

const NOW = '2026-05-26T15:00:00.000Z';
const MONDAY = '2026-05-25';

function buildRecord(
  overrides: Partial<ConciergeEnrichmentSummaryRecord> = {},
): ConciergeEnrichmentSummaryRecord {
  return {
    id: 'sum_1',
    householdId: 'hh_1',
    weekStartDate: MONDAY,
    status: 'draft',
    headline: 'A warm week',
    visitHighlights: 'Two visits.',
    wellnessSignals: 'Steady.',
    socialEngagement: 'Tea social.',
    additionalNotes: null,
    authoredByUserId: 'usr_concierge',
    publishedAt: null,
    publishedByUserId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface FakeService {
  createSummary: ReturnType<typeof vi.fn>;
  listSummaries: ReturnType<typeof vi.fn>;
  getSummary: ReturnType<typeof vi.fn>;
  updateSummary: ReturnType<typeof vi.fn>;
  listPublishedForHousehold: ReturnType<typeof vi.fn>;
  getPublishedForHousehold: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: EnrichmentController;
  service: FakeService;
} {
  const service: FakeService = {
    createSummary: vi.fn(
      async (): Promise<CreateSummaryOutcome> => ({ ok: true, summary: buildRecord() }),
    ),
    listSummaries: vi.fn(async () => [buildRecord()]),
    getSummary: vi.fn(async () => buildRecord()),
    updateSummary: vi.fn(
      async (): Promise<UpdateSummaryOutcome> => ({ ok: true, summary: buildRecord() }),
    ),
    listPublishedForHousehold: vi.fn(async () => [buildRecord({ status: 'published' })]),
    getPublishedForHousehold: vi.fn(async () => buildRecord({ status: 'published' })),
    ...overrides,
  };
  const controller = new EnrichmentController(service as unknown as EnrichmentService);
  return { controller, service };
}

function opsRequest(userId = 'user_ops'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

function householdRequest(householdId = 'hh_1', userId = 'user_family'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'household', householdId },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

describe('EnrichmentController.create', () => {
  it('forwards the body + actor and wraps the created summary', async () => {
    const { controller, service } = buildController();
    const result = await controller.create(
      {
        householdId: 'hh_9',
        weekStartDate: MONDAY,
        headline: 'Hi',
        visitHighlights: 'v',
        wellnessSignals: 'w',
        socialEngagement: 's',
        additionalNotes: 'n',
      },
      opsRequest('user_admin'),
    );
    expect(result.summary.id).toBe('sum_1');
    expect(service.createSummary).toHaveBeenCalledWith({
      householdId: 'hh_9',
      weekStartDate: MONDAY,
      headline: 'Hi',
      visitHighlights: 'v',
      wellnessSignals: 'w',
      socialEngagement: 's',
      additionalNotes: 'n',
      actorUserId: 'user_admin',
    });
  });

  it('maps week_taken to a 409', async () => {
    const { controller } = buildController({
      createSummary: vi.fn(
        async (): Promise<CreateSummaryOutcome> => ({ ok: false, reason: 'week_taken' }),
      ),
    });
    await expect(
      controller.create(
        {
          householdId: 'hh_1',
          weekStartDate: MONDAY,
          headline: 'Hi',
          visitHighlights: 'v',
          wellnessSignals: 'w',
          socialEngagement: 's',
        },
        opsRequest(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EnrichmentController.list', () => {
  it('forwards the query filters', async () => {
    const { controller, service } = buildController();
    await controller.list({ householdId: 'hh_2', status: 'published', limit: 10 });
    expect(service.listSummaries).toHaveBeenCalledWith({
      householdId: 'hh_2',
      status: 'published',
      limit: 10,
    });
  });
});

describe('EnrichmentController.get', () => {
  it('returns the summary when found', async () => {
    const { controller } = buildController();
    const result = await controller.get('sum_1');
    expect(result.summary.id).toBe('sum_1');
  });

  it('throws 404 when missing', async () => {
    const { controller } = buildController({ getSummary: vi.fn(async () => null) });
    await expect(controller.get('sum_missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EnrichmentController.update', () => {
  it('forwards the edit + status + actor', async () => {
    const { controller, service } = buildController();
    await controller.update(
      'sum_1',
      { headline: 'Revised', status: 'published' },
      opsRequest('user_admin'),
    );
    expect(service.updateSummary).toHaveBeenCalledWith({
      summaryId: 'sum_1',
      headline: 'Revised',
      visitHighlights: undefined,
      wellnessSignals: undefined,
      socialEngagement: undefined,
      additionalNotes: undefined,
      status: 'published',
      actorUserId: 'user_admin',
    });
  });

  it('maps not_found to 404', async () => {
    const { controller } = buildController({
      updateSummary: vi.fn(
        async (): Promise<UpdateSummaryOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.update('sum_x', { headline: 'x' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps invalid_transition to 409', async () => {
    const { controller } = buildController({
      updateSummary: vi.fn(
        async (): Promise<UpdateSummaryOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'draft',
          to: 'draft',
        }),
      ),
    });
    await expect(
      controller.update('sum_1', { status: 'draft' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EnrichmentController.listMine', () => {
  it('resolves the household from the token and returns published summaries', async () => {
    const { controller, service } = buildController();
    const result = await controller.listMine({ limit: 26 }, householdRequest('hh_42'));
    expect(result.householdId).toBe('hh_42');
    expect(result.summaries).toHaveLength(1);
    expect(service.listPublishedForHousehold).toHaveBeenCalledWith('hh_42', 26);
  });

  it('rejects a non-household-scoped actor with a 400', async () => {
    const { controller } = buildController();
    await expect(controller.listMine({ limit: 26 }, opsRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('EnrichmentController.getMine', () => {
  it('returns the permalink summary scoped to the household', async () => {
    const { controller, service } = buildController();
    const result = await controller.getMine('sum_7', householdRequest('hh_42'));
    expect(result.householdId).toBe('hh_42');
    expect(result.summary?.id).toBe('sum_1');
    expect(service.getPublishedForHousehold).toHaveBeenCalledWith('hh_42', 'sum_7');
  });

  it('returns a null summary when the permalink does not resolve', async () => {
    const { controller } = buildController({
      getPublishedForHousehold: vi.fn(async () => null),
    });
    const result = await controller.getMine('sum_missing', householdRequest());
    expect(result.summary).toBeNull();
  });

  it('rejects a non-household-scoped actor with a 400', async () => {
    const { controller } = buildController();
    await expect(controller.getMine('sum_1', opsRequest())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
