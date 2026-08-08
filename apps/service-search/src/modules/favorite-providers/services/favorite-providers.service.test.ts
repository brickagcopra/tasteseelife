import { FAVORITE_PROVIDERS_MAX_PER_OWNER } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { FavoriteProvidersService, OwnerQuotaExceededError } from './favorite-providers.service';

interface FakeRow {
  id: string;
  ownerUserId: string;
  providerId: string;
  seniorId: string | null;
  notes: string | null;
  createdAt: Date;
}

class FakePrisma {
  private nextId = 1;
  private clock = 0;
  rows: FakeRow[] = [];

  private nextClock(): Date {
    const base = Date.parse('2026-05-21T12:00:00.000Z');
    return new Date(base + this.clock++ * 1000);
  }

  favoriteProvider = {
    findMany: async (opts: {
      where: { ownerUserId: string; seniorId?: string | null; providerId?: string };
      orderBy?: { createdAt: 'asc' | 'desc' };
    }): Promise<FakeRow[]> => {
      const matches = this.rows.filter((r) => {
        if (r.ownerUserId !== opts.where.ownerUserId) return false;
        if (opts.where.seniorId !== undefined && r.seniorId !== opts.where.seniorId) return false;
        if (opts.where.providerId !== undefined && r.providerId !== opts.where.providerId) {
          return false;
        }
        return true;
      });
      return Promise.resolve(
        matches.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      );
    },
    findUnique: async (opts: { where: { id: string } }): Promise<FakeRow | null> => {
      return Promise.resolve(this.rows.find((r) => r.id === opts.where.id) ?? null);
    },
    findFirst: async (opts: {
      where: { ownerUserId: string; providerId: string; seniorId: string | null };
    }): Promise<FakeRow | null> => {
      return Promise.resolve(
        this.rows.find(
          (r) =>
            r.ownerUserId === opts.where.ownerUserId &&
            r.providerId === opts.where.providerId &&
            r.seniorId === opts.where.seniorId,
        ) ?? null,
      );
    },
    count: async (opts: { where: { ownerUserId: string } }): Promise<number> => {
      return Promise.resolve(
        this.rows.filter((r) => r.ownerUserId === opts.where.ownerUserId).length,
      );
    },
    create: async (opts: {
      data: {
        ownerUserId: string;
        providerId: string;
        seniorId: string | null;
        notes: string | null;
      };
    }): Promise<FakeRow> => {
      const now = this.nextClock();
      const created: FakeRow = {
        id: `fp_${this.nextId++}`,
        ownerUserId: opts.data.ownerUserId,
        providerId: opts.data.providerId,
        seniorId: opts.data.seniorId,
        notes: opts.data.notes,
        createdAt: now,
      };
      this.rows.push(created);
      return Promise.resolve(created);
    },
    update: async (opts: {
      where: { id: string };
      data: { notes: string | null };
    }): Promise<FakeRow> => {
      const row = this.rows.find((r) => r.id === opts.where.id);
      if (!row) throw new Error(`fake row not found: ${opts.where.id}`);
      row.notes = opts.data.notes;
      return Promise.resolve({ ...row });
    },
    delete: async (opts: { where: { id: string } }): Promise<FakeRow> => {
      const idx = this.rows.findIndex((r) => r.id === opts.where.id);
      if (idx < 0) throw new Error(`fake row not found: ${opts.where.id}`);
      const [removed] = this.rows.splice(idx, 1);
      return Promise.resolve(removed!);
    },
  };
}

describe('FavoriteProvidersService', () => {
  let prisma: FakePrisma;
  let service: FavoriteProvidersService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new FavoriteProvidersService(prisma as unknown as PrismaService);
  });

  describe('upsert', () => {
    it('creates a new bookmark on first call', async () => {
      const result = await service.upsert('user_a', {
        providerId: 'provider_chef',
        seniorId: 'senior_mom',
        notes: 'Loved the carbonara.',
      });
      expect(result.outcome).toBe('created');
      expect(result.favorite.providerId).toBe('provider_chef');
      expect(result.favorite.ownerUserId).toBe('user_a');
    });

    it('returns unchanged on byte-equal replay', async () => {
      await service.upsert('user_a', { providerId: 'provider_chef', notes: 'Great.' });
      const replay = await service.upsert('user_a', {
        providerId: 'provider_chef',
        notes: 'Great.',
      });
      expect(replay.outcome).toBe('unchanged');
    });

    it('returns updated when notes differ', async () => {
      await service.upsert('user_a', { providerId: 'provider_chef', notes: 'Great.' });
      const updated = await service.upsert('user_a', {
        providerId: 'provider_chef',
        notes: 'Even better the second time.',
      });
      expect(updated.outcome).toBe('updated');
      expect(updated.favorite.notes).toBe('Even better the second time.');
    });

    it('treats null seniorId and a specific seniorId as distinct tuples', async () => {
      const noSenior = await service.upsert('user_a', { providerId: 'provider_chef' });
      const forMom = await service.upsert('user_a', {
        providerId: 'provider_chef',
        seniorId: 'senior_mom',
      });
      expect(noSenior.outcome).toBe('created');
      expect(forMom.outcome).toBe('created');
      expect(noSenior.favorite.id).not.toBe(forMom.favorite.id);
    });

    it('rejects when the owner has hit the per-actor quota', async () => {
      for (let i = 0; i < FAVORITE_PROVIDERS_MAX_PER_OWNER; i++) {
        await service.upsert('user_a', { providerId: `provider_${i}` });
      }
      await expect(
        service.upsert('user_a', { providerId: 'provider_one_too_many' }),
      ).rejects.toBeInstanceOf(OwnerQuotaExceededError);
    });

    it('replays bypass the quota (idempotent upsert)', async () => {
      // Fill to cap.
      for (let i = 0; i < FAVORITE_PROVIDERS_MAX_PER_OWNER; i++) {
        await service.upsert('user_a', { providerId: `provider_${i}` });
      }
      // Replay an existing tuple — must succeed even at cap.
      const replay = await service.upsert('user_a', { providerId: 'provider_0' });
      expect(replay.outcome).toBe('unchanged');
    });
  });

  describe('listForOwner', () => {
    it("returns only the actor's own rows", async () => {
      await service.upsert('user_a', { providerId: 'p1' });
      await service.upsert('user_b', { providerId: 'p2' });
      await service.upsert('user_a', { providerId: 'p3' });

      const aList = await service.listForOwner('user_a');
      expect(aList).toHaveLength(2);
      expect(aList.map((r) => r.providerId).sort()).toEqual(['p1', 'p3']);
    });

    it('filters by seniorId when provided', async () => {
      await service.upsert('user_a', { providerId: 'p1', seniorId: 'senior_mom' });
      await service.upsert('user_a', { providerId: 'p2', seniorId: 'senior_dad' });
      await service.upsert('user_a', { providerId: 'p3' });

      const momOnly = await service.listForOwner('user_a', { seniorId: 'senior_mom' });
      expect(momOnly.map((r) => r.providerId)).toEqual(['p1']);
    });

    it('filters to no-senior favourites when seniorId is null', async () => {
      await service.upsert('user_a', { providerId: 'p1', seniorId: 'senior_mom' });
      await service.upsert('user_a', { providerId: 'p2' });

      const noSenior = await service.listForOwner('user_a', { seniorId: null });
      expect(noSenior.map((r) => r.providerId)).toEqual(['p2']);
    });

    it('filters by providerId when provided', async () => {
      await service.upsert('user_a', { providerId: 'p1', seniorId: 'senior_mom' });
      await service.upsert('user_a', { providerId: 'p1', seniorId: 'senior_dad' });
      await service.upsert('user_a', { providerId: 'p2' });

      const p1Only = await service.listForOwner('user_a', { providerId: 'p1' });
      expect(p1Only).toHaveLength(2);
      expect(p1Only.every((r) => r.providerId === 'p1')).toBe(true);
    });

    it('orders by createdAt desc', async () => {
      await service.upsert('user_a', { providerId: 'p_first' });
      await service.upsert('user_a', { providerId: 'p_second' });
      await service.upsert('user_a', { providerId: 'p_third' });

      const list = await service.listForOwner('user_a');
      expect(list.map((r) => r.providerId)).toEqual(['p_third', 'p_second', 'p_first']);
    });
  });

  describe('findByIdForOwner', () => {
    it('returns the row when owned', async () => {
      const { favorite } = await service.upsert('user_a', { providerId: 'p1' });
      const found = await service.findByIdForOwner('user_a', favorite.id);
      expect(found?.id).toBe(favorite.id);
    });

    it('returns null when the row belongs to another actor', async () => {
      const { favorite } = await service.upsert('user_a', { providerId: 'p1' });
      const found = await service.findByIdForOwner('user_b', favorite.id);
      expect(found).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the row and returns deleted', async () => {
      const { favorite } = await service.upsert('user_a', { providerId: 'p1' });
      const outcome = await service.delete('user_a', favorite.id);
      expect(outcome).toBe('deleted');
    });

    it('returns not_found on replay', async () => {
      const { favorite } = await service.upsert('user_a', { providerId: 'p1' });
      await service.delete('user_a', favorite.id);
      const replay = await service.delete('user_a', favorite.id);
      expect(replay).toBe('not_found');
    });

    it('returns not_found when the actor does not own the row (without deleting)', async () => {
      const { favorite } = await service.upsert('user_a', { providerId: 'p1' });
      const outcome = await service.delete('user_b', favorite.id);
      expect(outcome).toBe('not_found');
      expect(await service.findByIdForOwner('user_a', favorite.id)).not.toBeNull();
    });
  });
});
