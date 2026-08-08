import { beforeEach, describe, expect, it } from 'vitest';

import { WellnessSummaryService } from './wellness-summary.service';

/**
 * WellnessSummaryService.listHouseholds behavioural tests (TS-235).
 *
 * Coverage:
 *   - keyset pagination: `id > cursor`, `take = limit + 1` peek,
 *     `nextCursor` anchors on the LAST row of the RETURNED page (not the
 *     peek row) when more remain, null otherwise — incl. the boundary
 *     where the page exactly fills the limit with one more behind it.
 *   - min-1 filter: a household with no active senior, or no active
 *     recipient, is skipped server-side.
 *   - consent default: an absent `SeniorConsent` row => `notesConsent`
 *     false (opt-out); an explicit `notes: true` row => true.
 *   - enum mapping: senior status + member role pass through to the
 *     contract enum values.
 *   - the active-only filters (household status, senior deletedAt/status,
 *     member removedAt) are applied by the query the fake mirrors.
 */

type SeniorStatus = 'active' | 'paused' | 'archived';
type HouseholdStatus = 'pending' | 'active' | 'paused' | 'archived';
type MemberRole = 'primary_payer' | 'family_observer' | 'senior_user';

interface FakeHousehold {
  id: string;
  status: HouseholdStatus;
}

interface FakeSenior {
  id: string;
  householdId: string;
  firstName: string;
  status: SeniorStatus;
  deletedAt: Date | null;
}

interface FakeConsent {
  seniorId: string;
  notes: boolean;
}

interface FakeMember {
  householdId: string;
  userId: string;
  memberRole: MemberRole;
  removedAt: Date | null;
}

/**
 * Minimal Prisma fake — supports exactly the surface
 * `WellnessSummaryService.listHouseholds` touches:
 *   - household.findMany (active, id ASC, `id > cursor`, take limit+1)
 *   - senior.findMany    (active, non-deleted, householdId IN)
 *   - seniorConsent.findMany (relation filter on the senior)
 *   - householdMember.findMany (active, householdId IN)
 * No tenant-scope gate here — the service is exercised in isolation; the
 * exempt-frame wrap is proven in the controller test.
 */
class FakePrisma {
  public households: FakeHousehold[] = [];
  public seniors: FakeSenior[] = [];
  public consents: FakeConsent[] = [];
  public members: FakeMember[] = [];

  household = {
    findMany: async (args: {
      where: { status: 'active'; id?: { gt: string } };
      orderBy: { id: 'asc' };
      take: number;
      select: { id: true };
    }): Promise<Array<{ id: string }>> => {
      const after = args.where.id?.gt;
      const filtered = this.households
        .filter((h) => h.status === 'active')
        .filter((h) => (after === undefined ? true : h.id > after))
        .sort((a, b) => a.id.localeCompare(b.id));
      return filtered.slice(0, args.take).map((h) => ({ id: h.id }));
    },
  };

  senior = {
    findMany: async (args: {
      where: { householdId: { in: string[] }; deletedAt: null; status: 'active' };
      select: Record<string, true>;
    }): Promise<
      Array<{ id: string; householdId: string; firstName: string; status: SeniorStatus }>
    > => {
      const ids = new Set(args.where.householdId.in);
      return this.seniors
        .filter((s) => ids.has(s.householdId) && s.deletedAt === null && s.status === 'active')
        .map((s) => ({
          id: s.id,
          householdId: s.householdId,
          firstName: s.firstName,
          status: s.status,
        }));
    },
  };

  seniorConsent = {
    findMany: async (args: {
      where: { senior: { householdId: { in: string[] }; deletedAt: null; status: 'active' } };
      select: { seniorId: true; notes: true };
    }): Promise<Array<{ seniorId: string; notes: boolean }>> => {
      const ids = new Set(args.where.senior.householdId.in);
      // Only consent rows whose senior is an active, non-deleted senior in
      // the page — mirror the relation filter the service issues.
      const activeSeniorIds = new Set(
        this.seniors
          .filter((s) => ids.has(s.householdId) && s.deletedAt === null && s.status === 'active')
          .map((s) => s.id),
      );
      return this.consents
        .filter((c) => activeSeniorIds.has(c.seniorId))
        .map((c) => ({ seniorId: c.seniorId, notes: c.notes }));
    },
  };

  householdMember = {
    findMany: async (args: {
      where: { householdId: { in: string[] }; removedAt: null };
      select: Record<string, true>;
    }): Promise<Array<{ householdId: string; userId: string; memberRole: MemberRole }>> => {
      const ids = new Set(args.where.householdId.in);
      return this.members
        .filter((m) => ids.has(m.householdId) && m.removedAt === null)
        .map((m) => ({ householdId: m.householdId, userId: m.userId, memberRole: m.memberRole }));
    },
  };
}

function makeService(): { service: WellnessSummaryService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new WellnessSummaryService(prisma as unknown as never);
  return { service, prisma };
}

/** Seed a fully-formed (senior + recipient) active household. */
function seedFullHousehold(
  prisma: FakePrisma,
  id: string,
  opts: { notes?: boolean; seniorStatus?: SeniorStatus } = {},
): void {
  prisma.households.push({ id, status: 'active' });
  prisma.seniors.push({
    id: `sn_${id}`,
    householdId: id,
    firstName: 'Anna',
    status: opts.seniorStatus ?? 'active',
    deletedAt: null,
  });
  if (opts.notes !== undefined) {
    prisma.consents.push({ seniorId: `sn_${id}`, notes: opts.notes });
  }
  prisma.members.push({
    householdId: id,
    userId: `usr_${id}`,
    memberRole: 'primary_payer',
    removedAt: null,
  });
}

describe('WellnessSummaryService.listHouseholds', () => {
  let service: WellnessSummaryService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service, prisma } = makeService());
  });

  it('returns an empty page + null cursor when no active households exist', async () => {
    prisma.households.push({ id: 'hh_paused', status: 'paused' });
    const result = await service.listHouseholds({ limit: 100 });
    expect(result).toEqual({ households: [], nextCursor: null });
  });

  it('returns a full household with mapped seniors + recipients', async () => {
    seedFullHousehold(prisma, 'hh_1', { notes: true });
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households).toHaveLength(1);
    expect(result.households[0]).toEqual({
      householdId: 'hh_1',
      seniors: [{ seniorId: 'sn_hh_1', firstName: 'Anna', status: 'active', notesConsent: true }],
      recipients: [{ userId: 'usr_hh_1', role: 'primary_payer' }],
    });
    expect(result.nextCursor).toBeNull();
  });

  it('defaults notesConsent to false when no consent row exists (opt-out)', async () => {
    seedFullHousehold(prisma, 'hh_1'); // no consent row
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households[0]?.seniors[0]?.notesConsent).toBe(false);
  });

  it('honours an explicit notes:false consent row as false', async () => {
    seedFullHousehold(prisma, 'hh_1', { notes: false });
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households[0]?.seniors[0]?.notesConsent).toBe(false);
  });

  it('skips an active household that has no active senior', async () => {
    // Household + recipient, but its only senior is archived.
    prisma.households.push({ id: 'hh_1', status: 'active' });
    prisma.seniors.push({
      id: 'sn_archived',
      householdId: 'hh_1',
      firstName: 'Anna',
      status: 'archived',
      deletedAt: null,
    });
    prisma.members.push({
      householdId: 'hh_1',
      userId: 'usr_1',
      memberRole: 'primary_payer',
      removedAt: null,
    });
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households).toEqual([]);
  });

  it('skips an active household that has no active recipient', async () => {
    // Household + active senior, but the only member was removed.
    prisma.households.push({ id: 'hh_1', status: 'active' });
    prisma.seniors.push({
      id: 'sn_1',
      householdId: 'hh_1',
      firstName: 'Anna',
      status: 'active',
      deletedAt: null,
    });
    prisma.members.push({
      householdId: 'hh_1',
      userId: 'usr_gone',
      memberRole: 'primary_payer',
      removedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households).toEqual([]);
  });

  it('maps senior status + member role to the contract enum values', async () => {
    // The batch returns ACTIVE seniors only (a paused/archived senior gets
    // no monthly summary), so the status field is exercised at 'active';
    // the load-bearing assertion here is the three member-role mappings.
    prisma.households.push({ id: 'hh_1', status: 'active' });
    prisma.seniors.push({
      id: 'sn_1',
      householdId: 'hh_1',
      firstName: 'Anna',
      status: 'active',
      deletedAt: null,
    });
    prisma.members.push(
      { householdId: 'hh_1', userId: 'usr_payer', memberRole: 'primary_payer', removedAt: null },
      {
        householdId: 'hh_1',
        userId: 'usr_observer',
        memberRole: 'family_observer',
        removedAt: null,
      },
      { householdId: 'hh_1', userId: 'usr_senior', memberRole: 'senior_user', removedAt: null },
    );
    const result = await service.listHouseholds({ limit: 100 });
    expect(result.households[0]?.seniors[0]?.status).toBe('active');
    expect(result.households[0]?.recipients.map((r) => r.role)).toEqual([
      'primary_payer',
      'family_observer',
      'senior_user',
    ]);
  });

  it('walks the population by cursor, anchoring nextCursor on the LAST returned row (not the peek)', async () => {
    // Five full households, ids sort to hh_a..hh_e. Page size 2.
    for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
      seedFullHousehold(prisma, `hh_${suffix}`);
    }

    const page1 = await service.listHouseholds({ limit: 2 });
    expect(page1.households.map((h) => h.householdId)).toEqual(['hh_a', 'hh_b']);
    // hh_c is the peek; nextCursor must anchor on hh_b (the last RETURNED
    // row), so the next strict `> hh_b` query begins exactly at hh_c.
    expect(page1.nextCursor).toBe('hh_b');

    const page2 = await service.listHouseholds({ limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.households.map((h) => h.householdId)).toEqual(['hh_c', 'hh_d']);
    expect(page2.nextCursor).toBe('hh_d');

    const page3 = await service.listHouseholds({ limit: 2, cursor: page2.nextCursor ?? undefined });
    expect(page3.households.map((h) => h.householdId)).toEqual(['hh_e']);
    // No peek beyond hh_e → terminal page → null.
    expect(page3.nextCursor).toBeNull();
  });

  it('returns null nextCursor when the page exactly equals the remaining population (no peek row)', async () => {
    seedFullHousehold(prisma, 'hh_a');
    seedFullHousehold(prisma, 'hh_b');
    // Exactly two households, limit two — peek finds nothing beyond.
    const result = await service.listHouseholds({ limit: 2 });
    expect(result.households.map((h) => h.householdId)).toEqual(['hh_a', 'hh_b']);
    expect(result.nextCursor).toBeNull();
  });

  it('still advances the cursor on the raw household id even when a page row is filtered out', async () => {
    // hh_a is full; hh_b has no recipient (filtered); hh_c is the peek.
    seedFullHousehold(prisma, 'hh_a');
    prisma.households.push({ id: 'hh_b', status: 'active' });
    prisma.seniors.push({
      id: 'sn_b',
      householdId: 'hh_b',
      firstName: 'Bob',
      status: 'active',
      deletedAt: null,
    });
    // no member for hh_b → filtered out of the assembled page
    seedFullHousehold(prisma, 'hh_c');

    const page1 = await service.listHouseholds({ limit: 2 });
    // hh_b is dropped from the assembled page but the keyset window still
    // covered [hh_a, hh_b]; cursor anchors on hh_b (the raw last row).
    expect(page1.households.map((h) => h.householdId)).toEqual(['hh_a']);
    expect(page1.nextCursor).toBe('hh_b');

    const page2 = await service.listHouseholds({ limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.households.map((h) => h.householdId)).toEqual(['hh_c']);
    expect(page2.nextCursor).toBeNull();
  });
});
