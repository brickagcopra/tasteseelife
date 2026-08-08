import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SponsoredCampaignRepository } from './sponsored-campaign.repository';

/**
 * SponsoredCampaignRepository unit suite (TS-218a).
 *
 * Uses an in-memory FakePrisma (the platform FakePrisma convention) so the
 * eligibility filter (advertiserKind / status / flight window / approved
 * sponsored_listing creative) is asserted deterministically without a database.
 * The real read of the `unscopedModel`s against a live Postgres is exercised by
 * the Testcontainers followup.
 */

interface CampaignRow {
  readonly id: string;
  readonly advertiserKind: string;
  readonly advertiserId: string | null;
  readonly status: string;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly createdAt: Date;
  readonly creatives: ReadonlyArray<{ id: string; kind: string; status: string; createdAt: Date }>;
}

type WhereArg = {
  advertiserKind: string;
  status: string;
  advertiserId: { in: string[] };
  AND: ReadonlyArray<{ OR: ReadonlyArray<Record<string, unknown>> }>;
};

/**
 * A FakePrisma that reproduces the parts of the Prisma `findMany` semantics the
 * repository relies on: the top-level eligibility predicate, the candidate-id
 * `in` filter, the flight-window `startAt`/`endAt` OR clauses, and the nested
 * `creatives` projection (`where` by status+kind, `take: 1`, ordered oldest).
 */
class FakePrisma {
  constructor(private readonly rows: CampaignRow[]) {}

  adCampaign = {
    findMany: vi.fn(async (args: { where: WhereArg }) => {
      const { where } = args;
      const candidateSet = new Set(where.advertiserId.in);
      const matchesWindow = (row: CampaignRow): boolean =>
        where.AND.every((clause) =>
          clause.OR.some((cond) => {
            if ('startAt' in cond && cond.startAt === null) return row.startAt === null;
            if ('startAt' in cond) {
              const lte = (cond.startAt as { lte: Date }).lte;
              return row.startAt !== null && row.startAt.getTime() <= lte.getTime();
            }
            if ('endAt' in cond && cond.endAt === null) return row.endAt === null;
            if ('endAt' in cond) {
              const gt = (cond.endAt as { gt: Date }).gt;
              return row.endAt !== null && row.endAt.getTime() > gt.getTime();
            }
            return false;
          }),
        );

      return this.rows
        .filter(
          (row) =>
            row.advertiserKind === where.advertiserKind &&
            row.status === where.status &&
            row.advertiserId !== null &&
            candidateSet.has(row.advertiserId) &&
            matchesWindow(row),
        )
        .map((row) => ({
          id: row.id,
          advertiserId: row.advertiserId,
          startAt: row.startAt,
          createdAt: row.createdAt,
          creatives: row.creatives
            .filter((c) => c.status === 'approved' && c.kind === 'sponsored_listing')
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, 1)
            .map((c) => ({ id: c.id })),
        }));
    }),
  };
}

const NOW = new Date('2026-06-13T12:00:00.000Z');

function approvedCreative(id: string, createdAt = NOW) {
  return { id, kind: 'sponsored_listing', status: 'approved', createdAt };
}

function repoWith(rows: CampaignRow[]): SponsoredCampaignRepository {
  return new SponsoredCampaignRepository(new FakePrisma(rows) as unknown as PrismaService);
}

describe('SponsoredCampaignRepository.findActiveSponsoredCampaigns', () => {
  it('short-circuits to [] without a query when there are no candidates', async () => {
    const prisma = new FakePrisma([]);
    const repo = new SponsoredCampaignRepository(prisma as unknown as PrismaService);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: [], now: NOW });
    expect(result).toEqual([]);
    expect(prisma.adCampaign.findMany).not.toHaveBeenCalled();
  });

  it('returns an eligible active provider campaign with its approved creative', async () => {
    const repo = repoWith([
      {
        id: 'camp_1',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('crea_1')],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: ['prov_a'], now: NOW });
    expect(result).toEqual([
      {
        campaignId: 'camp_1',
        providerId: 'prov_a',
        creativeId: 'crea_1',
        startAt: null,
        createdAt: NOW,
      },
    ]);
  });

  it('excludes a campaign with no approved sponsored_listing creative', async () => {
    const repo = repoWith([
      {
        id: 'camp_pending',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [
          { id: 'crea_x', kind: 'sponsored_listing', status: 'pending_review', createdAt: NOW },
        ],
      },
      {
        id: 'camp_wrongkind',
        advertiserKind: 'provider',
        advertiserId: 'prov_b',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [{ id: 'crea_y', kind: 'banner', status: 'approved', createdAt: NOW }],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({
      providerIds: ['prov_a', 'prov_b'],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it('excludes non-provider, non-active, and out-of-window campaigns', async () => {
    const past = new Date('2026-06-10T00:00:00.000Z');
    const future = new Date('2026-06-20T00:00:00.000Z');
    const repo = repoWith([
      {
        id: 'camp_partner',
        advertiserKind: 'partner',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('c1')],
      },
      {
        id: 'camp_paused',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'paused',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('c2')],
      },
      {
        id: 'camp_not_started',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: future,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('c3')],
      },
      {
        id: 'camp_ended',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: past,
        endAt: past,
        createdAt: NOW,
        creatives: [approvedCreative('c4')],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: ['prov_a'], now: NOW });
    expect(result).toEqual([]);
  });

  it('includes a campaign whose flight window straddles now', async () => {
    const past = new Date('2026-06-10T00:00:00.000Z');
    const future = new Date('2026-06-20T00:00:00.000Z');
    const repo = repoWith([
      {
        id: 'camp_live',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: past,
        endAt: future,
        createdAt: past,
        creatives: [approvedCreative('crea_live', past)],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: ['prov_a'], now: NOW });
    expect(result.map((r) => r.campaignId)).toEqual(['camp_live']);
  });

  it('excludes a candidate not in the provided candidate set', async () => {
    const repo = repoWith([
      {
        id: 'camp_other',
        advertiserKind: 'provider',
        advertiserId: 'prov_z',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('crea_1')],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: ['prov_a'], now: NOW });
    expect(result).toEqual([]);
  });

  it('picks the oldest approved creative when several exist', async () => {
    const older = new Date('2026-06-01T00:00:00.000Z');
    const newer = new Date('2026-06-05T00:00:00.000Z');
    const repo = repoWith([
      {
        id: 'camp_1',
        advertiserKind: 'provider',
        advertiserId: 'prov_a',
        status: 'active',
        startAt: null,
        endAt: null,
        createdAt: NOW,
        creatives: [approvedCreative('crea_new', newer), approvedCreative('crea_old', older)],
      },
    ]);
    const result = await repo.findActiveSponsoredCampaigns({ providerIds: ['prov_a'], now: NOW });
    expect(result[0]?.creativeId).toBe('crea_old');
  });
});
