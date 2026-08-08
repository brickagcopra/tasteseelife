import { beforeEach, describe, expect, it } from 'vitest';

import { SeniorsDirectoryService } from './seniors-directory.service';

interface FakeSeniorRow {
  id: string;
  householdId: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  status: 'active' | 'paused' | 'archived';
  deletedAt: Date | null;
}

interface FakeMembership {
  householdId: string;
  userId: string;
  removedAt: Date | null;
}

/**
 * Minimal Prisma fake — supports the surface SeniorsDirectoryService
 * actually uses: householdMember.findMany (active memberships for a
 * user) and senior.findMany (active seniors in a set of households,
 * ordered). No tenant-scope gate here — the service is exercised in
 * isolation; the gate is proven in the AppModule integration path.
 */
class FakePrisma {
  public seniors: FakeSeniorRow[] = [];
  public memberships: FakeMembership[] = [];

  householdMember = {
    findMany: async (args: {
      where: { userId: string; removedAt: null };
      select: { householdId: true };
    }): Promise<Array<{ householdId: string }>> => {
      return this.memberships
        .filter((m) => m.userId === args.where.userId && m.removedAt === null)
        .map((m) => ({ householdId: m.householdId }));
    },
  };

  senior = {
    findMany: async (args: {
      where: { householdId: { in: string[] }; deletedAt: null };
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      select?: Record<string, true>;
    }): Promise<
      Array<{
        id: string;
        householdId: string;
        firstName: string;
        lastName: string;
        displayName: string | null;
        status: 'active' | 'paused' | 'archived';
      }>
    > => {
      const ids = new Set(args.where.householdId.in);
      const rows = this.seniors.filter((s) => ids.has(s.householdId) && s.deletedAt === null);
      // Mirror the service's orderBy: firstName, lastName, id (all asc).
      const sorted = [...rows].sort(
        (a, b) =>
          a.firstName.localeCompare(b.firstName) ||
          a.lastName.localeCompare(b.lastName) ||
          a.id.localeCompare(b.id),
      );
      return sorted.map((s) => ({
        id: s.id,
        householdId: s.householdId,
        firstName: s.firstName,
        lastName: s.lastName,
        displayName: s.displayName,
        status: s.status,
      }));
    },
  };
}

function makeService(): { service: SeniorsDirectoryService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  // The service only touches householdMember.findMany + senior.findMany.
  const service = new SeniorsDirectoryService(prisma as unknown as never);
  return { service, prisma };
}

describe('SeniorsDirectoryService.listForUser', () => {
  let service: SeniorsDirectoryService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service, prisma } = makeService());
  });

  it('returns an empty list when the user has no active memberships', async () => {
    prisma.seniors.push({
      id: 'senior_1',
      householdId: 'hh_1',
      firstName: 'Anna',
      lastName: 'K',
      displayName: null,
      status: 'active',
      deletedAt: null,
    });
    // No membership rows for this user.
    const result = await service.listForUser({ requesterUserId: 'user_stranger' });
    expect(result).toEqual({ seniors: [] });
  });

  it('returns the active seniors of the household the user belongs to', async () => {
    prisma.memberships.push({ householdId: 'hh_1', userId: 'user_payer', removedAt: null });
    prisma.seniors.push(
      {
        id: 'senior_mom',
        householdId: 'hh_1',
        firstName: 'Anna',
        lastName: 'Kowalski',
        displayName: 'Bobchi',
        status: 'active',
        deletedAt: null,
      },
      {
        id: 'senior_dad',
        householdId: 'hh_1',
        firstName: 'Józef',
        lastName: 'Kowalski',
        displayName: null,
        status: 'paused',
        deletedAt: null,
      },
    );

    const result = await service.listForUser({ requesterUserId: 'user_payer' });
    expect(result.seniors).toHaveLength(2);
    expect(result.seniors[0]).toEqual({
      seniorId: 'senior_mom',
      householdId: 'hh_1',
      firstName: 'Anna',
      lastName: 'Kowalski',
      displayName: 'Bobchi',
      status: 'active',
    });
    // Paused seniors are surfaced (only deleted ones are hidden).
    expect(result.seniors[1]?.status).toBe('paused');
  });

  it('excludes soft-deleted seniors', async () => {
    prisma.memberships.push({ householdId: 'hh_1', userId: 'user_payer', removedAt: null });
    prisma.seniors.push(
      {
        id: 'senior_active',
        householdId: 'hh_1',
        firstName: 'Anna',
        lastName: 'K',
        displayName: null,
        status: 'active',
        deletedAt: null,
      },
      {
        id: 'senior_gone',
        householdId: 'hh_1',
        firstName: 'Beatrice',
        lastName: 'K',
        displayName: null,
        status: 'archived',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    );

    const result = await service.listForUser({ requesterUserId: 'user_payer' });
    expect(result.seniors.map((s) => s.seniorId)).toEqual(['senior_active']);
  });

  it('does not surface seniors of households the user does not belong to', async () => {
    prisma.memberships.push({ householdId: 'hh_mine', userId: 'user_payer', removedAt: null });
    prisma.seniors.push(
      {
        id: 'senior_mine',
        householdId: 'hh_mine',
        firstName: 'Anna',
        lastName: 'K',
        displayName: null,
        status: 'active',
        deletedAt: null,
      },
      {
        id: 'senior_theirs',
        householdId: 'hh_other',
        firstName: 'Carl',
        lastName: 'Z',
        displayName: null,
        status: 'active',
        deletedAt: null,
      },
    );

    const result = await service.listForUser({ requesterUserId: 'user_payer' });
    expect(result.seniors.map((s) => s.seniorId)).toEqual(['senior_mine']);
  });

  it('aggregates seniors across multiple households the user belongs to', async () => {
    prisma.memberships.push(
      { householdId: 'hh_mom', userId: 'user_payer', removedAt: null },
      { householdId: 'hh_dad', userId: 'user_payer', removedAt: null },
    );
    prisma.seniors.push(
      {
        id: 'senior_mom',
        householdId: 'hh_mom',
        firstName: 'Anna',
        lastName: 'K',
        displayName: null,
        status: 'active',
        deletedAt: null,
      },
      {
        id: 'senior_dad',
        householdId: 'hh_dad',
        firstName: 'Bill',
        lastName: 'M',
        displayName: null,
        status: 'active',
        deletedAt: null,
      },
    );

    const result = await service.listForUser({ requesterUserId: 'user_payer' });
    // firstName asc → Anna before Bill.
    expect(result.seniors.map((s) => s.seniorId)).toEqual(['senior_mom', 'senior_dad']);
  });

  it('ignores removed memberships', async () => {
    prisma.memberships.push({
      householdId: 'hh_old',
      userId: 'user_payer',
      removedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    prisma.seniors.push({
      id: 'senior_old',
      householdId: 'hh_old',
      firstName: 'Anna',
      lastName: 'K',
      displayName: null,
      status: 'active',
      deletedAt: null,
    });

    const result = await service.listForUser({ requesterUserId: 'user_payer' });
    expect(result.seniors).toEqual([]);
  });
});
