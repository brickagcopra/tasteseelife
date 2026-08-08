import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD,
  type CreateEmergencyContactRequest,
  type UpdateEmergencyContactRequest,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { EmergencyContactsService } from './emergency-contacts.service';

interface FakeContactRow {
  id: string;
  householdId: string;
  name: string;
  relationship: string;
  phone: string;
  email: string | null;
  priority: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface FakeHouseholdRow {
  id: string;
  deletedAt: Date | null;
}

interface FakeMembership {
  id: string;
  householdId: string;
  userId: string;
  removedAt: Date | null;
}

/**
 * Minimal Prisma fake — supports the surface
 * `EmergencyContactsService` actually uses. Each method mirrors the
 * Prisma semantics we depend on (skip undefined fields on update, sort
 * findMany by priority + createdAt).
 */
class FakePrisma {
  public households: FakeHouseholdRow[] = [];
  public memberships: FakeMembership[] = [];
  public contacts: FakeContactRow[] = [];
  private idCounter = 0;

  household = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
    }): Promise<FakeHouseholdRow | null> => {
      const found = this.households.find((h) => h.id === args.where.id && h.deletedAt === null);
      return found ?? null;
    },
  };

  householdMember = {
    findFirst: async (args: {
      where: { householdId: string; userId: string; removedAt: null };
    }): Promise<FakeMembership | null> => {
      const found = this.memberships.find(
        (m) =>
          m.householdId === args.where.householdId &&
          m.userId === args.where.userId &&
          m.removedAt === null,
      );
      return found ?? null;
    },
  };

  emergencyContact = {
    findFirst: async (args: {
      where: {
        id: string;
        householdId: string;
        deletedAt?: null;
      };
    }): Promise<FakeContactRow | null> => {
      const found = this.contacts.find((c) => {
        if (c.id !== args.where.id) return false;
        if (c.householdId !== args.where.householdId) return false;
        if (args.where.deletedAt === null && c.deletedAt !== null) return false;
        return true;
      });
      return found ?? null;
    },
    findMany: async (args: {
      where: { householdId: string; deletedAt: null };
      orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
    }): Promise<FakeContactRow[]> => {
      const rows = this.contacts.filter(
        (c) => c.householdId === args.where.householdId && c.deletedAt === null,
      );
      // Apply the priority-then-createdAt ascending sort the service requests.
      return [...rows].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
    },
    count: async (args: { where: { householdId: string; deletedAt: null } }): Promise<number> => {
      return this.contacts.filter(
        (c) => c.householdId === args.where.householdId && c.deletedAt === null,
      ).length;
    },
    create: async (args: {
      data: {
        householdId: string;
        name: string;
        relationship: string;
        phone: string;
        email: string | null;
        priority: number;
        notes: string | null;
      };
    }): Promise<FakeContactRow> => {
      this.idCounter += 1;
      const now = new Date(2026, 4, 10, 12, 0, 0, this.idCounter);
      const row: FakeContactRow = {
        id: `ec_${this.idCounter}_${randomUUID()}`,
        householdId: args.data.householdId,
        name: args.data.name,
        relationship: args.data.relationship,
        phone: args.data.phone,
        email: args.data.email,
        priority: args.data.priority,
        notes: args.data.notes,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.contacts.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeContactRow>;
    }): Promise<FakeContactRow> => {
      const row = this.contacts.find((c) => c.id === args.where.id);
      if (row === undefined) throw new Error('contact row missing in fake');
      const writable = row as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        writable[key] = value;
      }
      row.updatedAt = new Date();
      return row;
    },
  };
}

function newHousehold(overrides: Partial<FakeHouseholdRow> = {}): FakeHouseholdRow {
  return { id: `hh_${randomUUID()}`, deletedAt: null, ...overrides };
}

function createInput(
  overrides: Partial<CreateEmergencyContactRequest> = {},
): CreateEmergencyContactRequest {
  return {
    name: 'Alice Schwartz',
    relationship: 'Adult daughter',
    phone: '+14155551212',
    priority: 1,
    ...overrides,
  };
}

describe('EmergencyContactsService.list', () => {
  let prisma: FakePrisma;
  let service: EmergencyContactsService;
  let household: FakeHouseholdRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: narrow Prisma surface only.
    service = new EmergencyContactsService(prisma as any);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('returns an empty list when no contacts exist', async () => {
    const result = await service.list({
      householdId: household.id,
      requesterUserId: memberUserId,
    });
    expect(result.contacts).toEqual([]);
  });

  it('returns contacts in priority-then-createdAt order, filtering soft-deleted', async () => {
    await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput({ name: 'Third', priority: 3 }),
    });
    await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput({ name: 'First', priority: 1 }),
    });
    await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput({ name: 'Second', priority: 2 }),
    });
    // Soft-delete the priority-2 contact.
    const middle = prisma.contacts.find((c) => c.name === 'Second');
    if (middle === undefined) throw new Error('test fixture missing');
    middle.deletedAt = new Date();

    const result = await service.list({
      householdId: household.id,
      requesterUserId: memberUserId,
    });
    expect(result.contacts.map((c) => c.name)).toEqual(['First', 'Third']);
  });

  it('rejects a stranger with 403', async () => {
    await expect(
      service.list({ householdId: household.id, requesterUserId: 'usr_stranger' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EmergencyContactsService.create', () => {
  let prisma: FakePrisma;
  let service: EmergencyContactsService;
  let household: FakeHouseholdRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new EmergencyContactsService(prisma as any);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('persists a new contact and returns the DTO', async () => {
    const result = await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    expect(result.name).toBe('Alice Schwartz');
    expect(result.householdId).toBe(household.id);
    expect(result.email).toBeNull();
    expect(result.notes).toBeNull();
    expect(prisma.contacts).toHaveLength(1);
  });

  it('throws 422 when the household is at the cap', async () => {
    for (let i = 0; i < EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD; i++) {
      await service.create({
        householdId: household.id,
        requesterUserId: memberUserId,
        input: createInput({ name: `Contact ${i}`, priority: 1 }),
      });
    }
    await expect(
      service.create({
        householdId: household.id,
        requesterUserId: memberUserId,
        input: createInput({ name: 'Overflow', priority: 1 }),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('soft-deleted contacts free up cap headroom', async () => {
    for (let i = 0; i < EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD; i++) {
      await service.create({
        householdId: household.id,
        requesterUserId: memberUserId,
        input: createInput({ name: `Contact ${i}`, priority: 1 }),
      });
    }
    // Soft-delete one.
    if (prisma.contacts[0]) prisma.contacts[0].deletedAt = new Date();
    // A new create must now succeed.
    const result = await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput({ name: 'Replacement', priority: 1 }),
    });
    expect(result.name).toBe('Replacement');
  });

  it('returns 404 when the household does not exist', async () => {
    await expect(
      service.create({
        householdId: 'hh_missing',
        requesterUserId: memberUserId,
        input: createInput(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a member', async () => {
    await expect(
      service.create({
        householdId: household.id,
        requesterUserId: 'usr_stranger',
        input: createInput(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EmergencyContactsService.update', () => {
  let prisma: FakePrisma;
  let service: EmergencyContactsService;
  let household: FakeHouseholdRow;
  let memberUserId: string;
  let contactId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new EmergencyContactsService(prisma as any);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
    const created = await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    contactId = created.id;
  });

  it('patches a single field', async () => {
    const result = await service.update({
      householdId: household.id,
      contactId,
      requesterUserId: memberUserId,
      input: { priority: 2 } satisfies UpdateEmergencyContactRequest,
    });
    expect(result.priority).toBe(2);
    expect(result.name).toBe('Alice Schwartz'); // untouched
  });

  it('clears email / notes when set to null', async () => {
    await service.update({
      householdId: household.id,
      contactId,
      requesterUserId: memberUserId,
      input: { email: 'alice@example.com', notes: 'temp' },
    });
    const cleared = await service.update({
      householdId: household.id,
      contactId,
      requesterUserId: memberUserId,
      input: { email: null, notes: null },
    });
    expect(cleared.email).toBeNull();
    expect(cleared.notes).toBeNull();
  });

  it('rejects an empty patch with 400', async () => {
    await expect(
      service.update({
        householdId: household.id,
        contactId,
        requesterUserId: memberUserId,
        input: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 when the contact does not exist', async () => {
    await expect(
      service.update({
        householdId: household.id,
        contactId: 'ec_missing',
        requesterUserId: memberUserId,
        input: { priority: 2 },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the contact belongs to a different household', async () => {
    const otherHousehold = newHousehold();
    prisma.households.push(otherHousehold);
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: otherHousehold.id,
      userId: memberUserId,
      removedAt: null,
    });
    await expect(
      service.update({
        householdId: otherHousehold.id,
        contactId,
        requesterUserId: memberUserId,
        input: { priority: 2 },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the contact is soft-deleted', async () => {
    const row = prisma.contacts.find((c) => c.id === contactId);
    if (row === undefined) throw new Error('fixture missing');
    row.deletedAt = new Date();
    await expect(
      service.update({
        householdId: household.id,
        contactId,
        requesterUserId: memberUserId,
        input: { priority: 2 },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a member', async () => {
    await expect(
      service.update({
        householdId: household.id,
        contactId,
        requesterUserId: 'usr_stranger',
        input: { priority: 2 },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EmergencyContactsService.remove', () => {
  let prisma: FakePrisma;
  let service: EmergencyContactsService;
  let household: FakeHouseholdRow;
  let memberUserId: string;
  let contactId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new EmergencyContactsService(prisma as any);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
    const created = await service.create({
      householdId: household.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    contactId = created.id;
  });

  it('soft-deletes the row', async () => {
    await service.remove({
      householdId: household.id,
      contactId,
      requesterUserId: memberUserId,
    });
    const row = prisma.contacts.find((c) => c.id === contactId);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('is idempotent on a previously-deleted row', async () => {
    await service.remove({
      householdId: household.id,
      contactId,
      requesterUserId: memberUserId,
    });
    await expect(
      service.remove({
        householdId: household.id,
        contactId,
        requesterUserId: memberUserId,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns 404 when the contact does not exist', async () => {
    await expect(
      service.remove({
        householdId: household.id,
        contactId: 'ec_missing',
        requesterUserId: memberUserId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a member', async () => {
    await expect(
      service.remove({
        householdId: household.id,
        contactId,
        requesterUserId: 'usr_stranger',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
