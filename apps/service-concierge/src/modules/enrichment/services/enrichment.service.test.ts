import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { EnrichmentService } from './enrichment.service';

/**
 * Unit tests for `EnrichmentService` (TS-229).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeEnrichmentSummary` surface the service consumes (create / findMany
 * / findFirst / update). The one-per-household-week partial unique index is
 * modelled by throwing a P2002-shaped error from `create` when a non-deleted
 * row already exists for the same `(householdId, weekStartDate)`. The real
 * partial-unique / FK guarantees are covered by the Testcontainers integration
 * test (followup); this suite pins the service's branching + the publish /
 * unpublish / archive stamp logic.
 */

interface SummarySeed {
  id: string;
  householdId: string;
  weekStartDate: Date;
  status: 'draft' | 'published' | 'archived';
  headline: string;
  visitHighlights: string;
  wellnessSignals: string;
  socialEngagement: string;
  additionalNotes: string | null;
  authoredByUserId: string | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const BASE = new Date('2026-05-26T15:00:00.000Z');
const UPDATED = new Date('2026-05-27T00:00:00.000Z');

class P2002Error extends Error {
  public readonly code = 'P2002';
}

let idCounter = 0;

class FakePrisma {
  public summaries: SummarySeed[] = [];

  public get conciergeEnrichmentSummary() {
    return {
      create: async (args: { data: Record<string, unknown>; select?: unknown }) => {
        const d = args.data;
        const householdId = String(d['householdId']);
        const weekStartDate = d['weekStartDate'] as Date;
        if (
          this.summaries.some(
            (s) =>
              s.householdId === householdId &&
              s.deletedAt === null &&
              s.weekStartDate.getTime() === weekStartDate.getTime(),
          )
        ) {
          throw new P2002Error('unique violation');
        }
        idCounter += 1;
        const row: SummarySeed = {
          id: `sum_${idCounter}`,
          householdId,
          weekStartDate,
          status: (d['status'] as SummarySeed['status']) ?? 'draft',
          headline: String(d['headline']),
          visitHighlights: String(d['visitHighlights']),
          wellnessSignals: String(d['wellnessSignals']),
          socialEngagement: String(d['socialEngagement']),
          additionalNotes: (d['additionalNotes'] as string | null) ?? null,
          authoredByUserId: (d['authoredByUserId'] as string | null) ?? null,
          publishedAt: null,
          publishedByUserId: null,
          archivedAt: null,
          createdAt: BASE,
          updatedAt: BASE,
          deletedAt: null,
        };
        this.summaries.push(row);
        return { ...row };
      },
      findFirst: async (args: { where: Record<string, unknown>; select?: unknown }) => {
        const match = this.summaries.find((s) => matches(s, args.where));
        return match === undefined ? null : { ...match };
      },
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        let result = this.summaries.filter((s) => matches(s, args.where));
        result = [...result].sort((a, b) => {
          const week = b.weekStartDate.getTime() - a.weekStartDate.getTime();
          return week !== 0 ? week : b.id.localeCompare(a.id);
        });
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result.map((r) => ({ ...r }));
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = this.summaries.find((s) => s.id === args.where.id);
        if (row === undefined) throw new Error(`summary ${args.where.id} not found`);
        Object.assign(row, args.data, { updatedAt: UPDATED });
        return { ...row };
      },
    };
  }
}

function matches(s: SummarySeed, where: Record<string, unknown>): boolean {
  if ('id' in where && s.id !== where['id']) return false;
  if ('householdId' in where && s.householdId !== where['householdId']) return false;
  if ('status' in where && s.status !== where['status']) return false;
  if ('deletedAt' in where && where['deletedAt'] === null && s.deletedAt !== null) return false;
  return true;
}

function makeService(): { service: EnrichmentService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new EnrichmentService(prisma as unknown as PrismaService);
  return { service, prisma };
}

const MONDAY = '2026-05-25';
const PRIOR_MONDAY = '2026-05-18';

function createInput(overrides: Record<string, unknown> = {}): {
  householdId: string;
  weekStartDate: string;
  headline: string;
  visitHighlights: string;
  wellnessSignals: string;
  socialEngagement: string;
  actorUserId: string;
} & Record<string, unknown> {
  return {
    householdId: 'hh_1',
    weekStartDate: MONDAY,
    headline: 'A warm week',
    visitHighlights: 'Two visits.',
    wellnessSignals: 'Steady.',
    socialEngagement: 'Tea social.',
    actorUserId: 'usr_concierge',
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
});

describe('EnrichmentService.createSummary', () => {
  it('creates a draft, stamps the author, and projects the week back to YYYY-MM-DD', async () => {
    const { service } = makeService();
    const outcome = await service.createSummary(createInput());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.status).toBe('draft');
    expect(outcome.summary.weekStartDate).toBe(MONDAY);
    expect(outcome.summary.authoredByUserId).toBe('usr_concierge');
    expect(outcome.summary.publishedAt).toBeNull();
    expect(outcome.summary.archivedAt).toBeNull();
    expect(outcome.summary.additionalNotes).toBeNull();
  });

  it('persists optional additionalNotes', async () => {
    const { service } = makeService();
    const outcome = await service.createSummary(
      createInput({ additionalNotes: 'Loves osso buco.' }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.additionalNotes).toBe('Loves osso buco.');
  });

  it('rejects a second summary for the same household + week (week_taken)', async () => {
    const { service } = makeService();
    await service.createSummary(createInput());
    const second = await service.createSummary(createInput());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('week_taken');
  });

  it('allows the same household a summary for a different week', async () => {
    const { service } = makeService();
    await service.createSummary(createInput());
    const other = await service.createSummary(createInput({ weekStartDate: PRIOR_MONDAY }));
    expect(other.ok).toBe(true);
  });

  it('allows different households the same week', async () => {
    const { service } = makeService();
    await service.createSummary(createInput());
    const other = await service.createSummary(createInput({ householdId: 'hh_2' }));
    expect(other.ok).toBe(true);
  });
});

describe('EnrichmentService.listSummaries', () => {
  it('returns matching summaries newest-week-first', async () => {
    const { service } = makeService();
    await service.createSummary(createInput({ weekStartDate: PRIOR_MONDAY }));
    await service.createSummary(createInput({ weekStartDate: MONDAY }));

    const list = await service.listSummaries({ limit: 50 });
    expect(list.map((s) => s.weekStartDate)).toEqual([MONDAY, PRIOR_MONDAY]);
  });

  it('filters by household and by status', async () => {
    const { service } = makeService();
    await service.createSummary(createInput({ householdId: 'hh_1' }));
    await service.createSummary(createInput({ householdId: 'hh_2' }));

    const byHousehold = await service.listSummaries({ householdId: 'hh_2', limit: 50 });
    expect(byHousehold).toHaveLength(1);
    expect(byHousehold[0]?.householdId).toBe('hh_2');

    const byStatus = await service.listSummaries({ status: 'published', limit: 50 });
    expect(byStatus).toHaveLength(0);
  });

  it('honours the limit', async () => {
    const { service } = makeService();
    await service.createSummary(createInput({ weekStartDate: PRIOR_MONDAY }));
    await service.createSummary(createInput({ weekStartDate: MONDAY }));
    const list = await service.listSummaries({ limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]?.weekStartDate).toBe(MONDAY);
  });
});

describe('EnrichmentService.getSummary', () => {
  it('returns the summary on a hit', async () => {
    const { service } = makeService();
    const created = await service.createSummary(createInput());
    if (!created.ok) throw new Error('setup failed');
    const found = await service.getSummary(created.summary.id);
    expect(found?.id).toBe(created.summary.id);
  });

  it('returns null for a missing id', async () => {
    const { service } = makeService();
    expect(await service.getSummary('sum_missing')).toBeNull();
  });
});

describe('EnrichmentService.updateSummary', () => {
  async function seedDraft(): Promise<{ service: EnrichmentService; id: string }> {
    const { service } = makeService();
    const created = await service.createSummary(createInput());
    if (!created.ok) throw new Error('setup failed');
    return { service, id: created.summary.id };
  }

  it('edits content fields without touching status', async () => {
    const { service, id } = await seedDraft();
    const outcome = await service.updateSummary({
      summaryId: id,
      headline: 'Revised headline',
      actorUserId: 'usr_concierge',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.headline).toBe('Revised headline');
    expect(outcome.summary.status).toBe('draft');
  });

  it('returns not_found for a missing summary', async () => {
    const { service } = makeService();
    const outcome = await service.updateSummary({
      summaryId: 'sum_missing',
      headline: 'x',
      actorUserId: 'usr_concierge',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_found');
  });

  it('publishing stamps publishedAt + publishedByUserId', async () => {
    const { service, id } = await seedDraft();
    const outcome = await service.updateSummary({
      summaryId: id,
      status: 'published',
      actorUserId: 'usr_publisher',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.status).toBe('published');
    expect(outcome.summary.publishedAt).not.toBeNull();
    expect(outcome.summary.publishedByUserId).toBe('usr_publisher');
    expect(outcome.summary.archivedAt).toBeNull();
  });

  it('archiving a published summary stamps archivedAt and keeps publishedAt', async () => {
    const { service, id } = await seedDraft();
    await service.updateSummary({ summaryId: id, status: 'published', actorUserId: 'usr_p' });
    const outcome = await service.updateSummary({
      summaryId: id,
      status: 'archived',
      actorUserId: 'usr_p',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.status).toBe('archived');
    expect(outcome.summary.archivedAt).not.toBeNull();
    expect(outcome.summary.publishedAt).not.toBeNull();
  });

  it('unpublishing back to draft clears publish + archive stamps', async () => {
    const { service, id } = await seedDraft();
    await service.updateSummary({ summaryId: id, status: 'published', actorUserId: 'usr_p' });
    const outcome = await service.updateSummary({
      summaryId: id,
      status: 'draft',
      actorUserId: 'usr_p',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.status).toBe('draft');
    expect(outcome.summary.publishedAt).toBeNull();
    expect(outcome.summary.publishedByUserId).toBeNull();
    expect(outcome.summary.archivedAt).toBeNull();
  });

  it('a status equal to the current state is a no-op that does not re-stamp', async () => {
    const { service, id } = await seedDraft();
    const published = await service.updateSummary({
      summaryId: id,
      status: 'published',
      actorUserId: 'usr_first',
    });
    if (!published.ok) throw new Error('setup failed');
    const firstPublishedAt = published.summary.publishedAt;

    const again = await service.updateSummary({
      summaryId: id,
      status: 'published',
      actorUserId: 'usr_second',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // The publisher + timestamp are untouched — no re-stamp on the no-op.
    expect(again.summary.publishedByUserId).toBe('usr_first');
    expect(again.summary.publishedAt).toBe(firstPublishedAt);
  });
});

describe('EnrichmentService family reads', () => {
  async function seedPublished(
    householdId: string,
    weekStartDate: string,
  ): Promise<{ service: EnrichmentService; id: string }> {
    const { service } = makeService();
    const created = await service.createSummary(createInput({ householdId, weekStartDate }));
    if (!created.ok) throw new Error('setup failed');
    const published = await service.updateSummary({
      summaryId: created.summary.id,
      status: 'published',
      actorUserId: 'usr_p',
    });
    if (!published.ok) throw new Error('setup failed');
    return { service, id: created.summary.id };
  }

  it('lists only published summaries for the household, newest-week-first', async () => {
    const { service } = makeService();
    const a = await service.createSummary(createInput({ weekStartDate: PRIOR_MONDAY }));
    const b = await service.createSummary(createInput({ weekStartDate: MONDAY }));
    if (!a.ok || !b.ok) throw new Error('setup failed');
    // Publish only the older one.
    await service.updateSummary({ summaryId: a.summary.id, status: 'published', actorUserId: 'p' });

    const list = await service.listPublishedForHousehold('hh_1', 50);
    expect(list).toHaveLength(1);
    expect(list[0]?.weekStartDate).toBe(PRIOR_MONDAY);
  });

  it("does not return another household's published summaries", async () => {
    const { service } = await seedPublished('hh_1', MONDAY);
    const list = await service.listPublishedForHousehold('hh_2', 50);
    expect(list).toHaveLength(0);
  });

  it('permalink read returns a published summary scoped to the household', async () => {
    const { service, id } = await seedPublished('hh_1', MONDAY);
    const found = await service.getPublishedForHousehold('hh_1', id);
    expect(found?.id).toBe(id);
  });

  it('permalink read returns null for a draft summary', async () => {
    const { service } = makeService();
    const created = await service.createSummary(createInput());
    if (!created.ok) throw new Error('setup failed');
    expect(await service.getPublishedForHousehold('hh_1', created.summary.id)).toBeNull();
  });

  it('permalink read returns null for a foreign household (no oracle)', async () => {
    const { service, id } = await seedPublished('hh_1', MONDAY);
    expect(await service.getPublishedForHousehold('hh_2', id)).toBeNull();
  });

  it('permalink read returns null for a missing id', async () => {
    const { service } = await seedPublished('hh_1', MONDAY);
    expect(await service.getPublishedForHousehold('hh_1', 'sum_missing')).toBeNull();
  });
});
