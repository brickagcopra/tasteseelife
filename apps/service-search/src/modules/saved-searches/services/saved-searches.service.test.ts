import {
  SAVED_SEARCHES_MAX_PER_OWNER,
  type SearchProvidersRequest,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { OwnerQuotaExceededError, SavedSearchesService } from './saved-searches.service';

interface FakeRow {
  id: string;
  ownerUserId: string;
  seniorId: string | null;
  name: string;
  query: unknown;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  private nextId = 1;
  private clock = 0;
  rows: FakeRow[] = [];

  private nextClock(): Date {
    const base = Date.parse('2026-05-21T12:00:00.000Z');
    return new Date(base + this.clock++ * 1000);
  }

  savedSearch = {
    findMany: async (opts: {
      where: { ownerUserId: string };
      orderBy?: ReadonlyArray<Record<string, unknown>>;
    }): Promise<FakeRow[]> => {
      const owned = this.rows.filter((r) => r.ownerUserId === opts.where.ownerUserId);
      // Sort by lastRunAt DESC nulls last, then createdAt DESC.
      return Promise.resolve(
        owned.slice().sort((a, b) => {
          if (a.lastRunAt === null && b.lastRunAt !== null) return 1;
          if (a.lastRunAt !== null && b.lastRunAt === null) return -1;
          if (a.lastRunAt !== null && b.lastRunAt !== null) {
            const diff = b.lastRunAt.getTime() - a.lastRunAt.getTime();
            if (diff !== 0) return diff;
          }
          return b.createdAt.getTime() - a.createdAt.getTime();
        }),
      );
    },
    findUnique: async (opts: { where: { id: string } }): Promise<FakeRow | null> => {
      return Promise.resolve(this.rows.find((r) => r.id === opts.where.id) ?? null);
    },
    count: async (opts: { where: { ownerUserId: string } }): Promise<number> => {
      return Promise.resolve(
        this.rows.filter((r) => r.ownerUserId === opts.where.ownerUserId).length,
      );
    },
    create: async (opts: {
      data: {
        ownerUserId: string;
        seniorId: string | null;
        name: string;
        query: unknown;
      };
    }): Promise<FakeRow> => {
      const now = this.nextClock();
      const created: FakeRow = {
        id: `ss_${this.nextId++}`,
        ownerUserId: opts.data.ownerUserId,
        seniorId: opts.data.seniorId,
        name: opts.data.name,
        query: opts.data.query,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(created);
      return Promise.resolve(created);
    },
    update: async (opts: {
      where: { id: string };
      data: { name?: string; seniorId?: string | null; query?: unknown; lastRunAt?: Date };
    }): Promise<FakeRow> => {
      const row = this.rows.find((r) => r.id === opts.where.id);
      if (!row) throw new Error(`fake row not found: ${opts.where.id}`);
      if (opts.data.name !== undefined) row.name = opts.data.name;
      if ('seniorId' in opts.data) row.seniorId = opts.data.seniorId ?? null;
      if (opts.data.query !== undefined) row.query = opts.data.query;
      if (opts.data.lastRunAt !== undefined) row.lastRunAt = opts.data.lastRunAt;
      row.updatedAt = this.nextClock();
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

const sampleQuery: SearchProvidersRequest = {
  query: 'italian',
  sort: 'relevance',
  limit: 20,
};

describe('SavedSearchesService', () => {
  let prisma: FakePrisma;
  let service: SavedSearchesService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new SavedSearchesService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('persists a saved search and stamps the owner id', async () => {
      const created = await service.create('user_payer', {
        name: 'Italian chefs',
        seniorId: 'senior_mom',
        query: sampleQuery,
      });
      expect(created.ownerUserId).toBe('user_payer');
      expect(created.seniorId).toBe('senior_mom');
      expect(created.name).toBe('Italian chefs');
      expect(created.query).toEqual(sampleQuery);
      expect(created.lastRunAt).toBeNull();
    });

    it('defaults seniorId to null when omitted', async () => {
      const created = await service.create('user_payer', {
        name: 'Generic search',
        query: sampleQuery,
      });
      expect(created.seniorId).toBeNull();
    });

    it('rejects when the owner has hit the per-actor quota', async () => {
      for (let i = 0; i < SAVED_SEARCHES_MAX_PER_OWNER; i++) {
        await service.create('user_payer', {
          name: `Search ${i}`,
          query: sampleQuery,
        });
      }
      await expect(
        service.create('user_payer', { name: 'one too many', query: sampleQuery }),
      ).rejects.toBeInstanceOf(OwnerQuotaExceededError);
    });
  });

  describe('listForOwner', () => {
    it("returns only the actor's own rows", async () => {
      await service.create('user_a', { name: 'A1', query: sampleQuery });
      await service.create('user_b', { name: 'B1', query: sampleQuery });
      await service.create('user_a', { name: 'A2', query: sampleQuery });

      const aList = await service.listForOwner('user_a');
      expect(aList).toHaveLength(2);
      expect(aList.map((r) => r.name).sort()).toEqual(['A1', 'A2']);

      const bList = await service.listForOwner('user_b');
      expect(bList).toHaveLength(1);
    });

    it('sorts by lastRunAt desc nulls last, then createdAt desc', async () => {
      const first = await service.create('user_a', { name: 'first', query: sampleQuery });
      const second = await service.create('user_a', { name: 'second', query: sampleQuery });
      const third = await service.create('user_a', { name: 'third', query: sampleQuery });

      // Run the FIRST one — it should jump to the top because lastRunAt
      // is now set, even though it was created earliest.
      await service.run('user_a', first.id);

      const list = await service.listForOwner('user_a');
      expect(list.map((r) => r.name)).toEqual(['first', 'third', 'second']);
      void second;
      void third;
    });
  });

  describe('findByIdForOwner', () => {
    it('returns the row when owned', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const found = await service.findByIdForOwner('user_a', created.id);
      expect(found?.id).toBe(created.id);
    });

    it('returns null when the row belongs to another actor', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const found = await service.findByIdForOwner('user_b', created.id);
      expect(found).toBeNull();
    });

    it('returns null when the row does not exist', async () => {
      expect(await service.findByIdForOwner('user_a', 'ss_missing')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates the editable fields and leaves the others intact', async () => {
      const created = await service.create('user_a', {
        name: 'Original',
        seniorId: 'senior_mom',
        query: sampleQuery,
      });

      const updated = await service.update('user_a', created.id, { name: 'Renamed' });
      expect(updated?.name).toBe('Renamed');
      expect(updated?.seniorId).toBe('senior_mom');
      expect(updated?.query).toEqual(sampleQuery);
    });

    it('clears seniorId when explicitly set to null', async () => {
      const created = await service.create('user_a', {
        name: 'Original',
        seniorId: 'senior_mom',
        query: sampleQuery,
      });
      const updated = await service.update('user_a', created.id, { seniorId: null });
      expect(updated?.seniorId).toBeNull();
    });

    it('returns null when the actor does not own the row', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const updated = await service.update('user_b', created.id, { name: 'Hijack' });
      expect(updated).toBeNull();
    });

    it('returns the row unchanged when patch is empty', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const updated = await service.update('user_a', created.id, {});
      expect(updated?.id).toBe(created.id);
      expect(updated?.name).toBe('A');
    });
  });

  describe('run', () => {
    it('bumps lastRunAt to a non-null value', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      expect(created.lastRunAt).toBeNull();
      const ran = await service.run('user_a', created.id);
      expect(ran?.lastRunAt).not.toBeNull();
    });

    it('returns null when the actor does not own the row', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const ran = await service.run('user_b', created.id);
      expect(ran).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the row and returns deleted', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const outcome = await service.delete('user_a', created.id);
      expect(outcome).toBe('deleted');
      expect(await service.findByIdForOwner('user_a', created.id)).toBeNull();
    });

    it('returns not_found on replay', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      await service.delete('user_a', created.id);
      const replay = await service.delete('user_a', created.id);
      expect(replay).toBe('not_found');
    });

    it('returns not_found when the actor does not own the row (without deleting)', async () => {
      const created = await service.create('user_a', { name: 'A', query: sampleQuery });
      const outcome = await service.delete('user_b', created.id);
      expect(outcome).toBe('not_found');
      // Row still exists.
      expect(await service.findByIdForOwner('user_a', created.id)).not.toBeNull();
    });
  });
});
