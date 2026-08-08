import type {
  PagerDutyClient,
  PagerDutyEnqueueInput,
  PagerDutyEnqueueResult,
} from '@taste-and-see/nest-pagerduty';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { EmergencyService } from './emergency.service';

/**
 * Unit tests for `EmergencyService` (TS-225).
 *
 * `FakePrisma` mirrors the narrow surface the service consumes
 * (`conciergeAssignment.findFirst` routing lookup + `conciergeTicket.create`)
 * — the same shape as the TS-223 `TicketsService` test. `FakePagerDuty`
 * records the enqueue input and returns a configurable result so we can pin
 * the payload + the best-effort degradation behaviour. No real
 * transactional / network behaviour — the integration test against a real
 * Postgres carries the migration + persistence guarantees.
 */

interface ConciergeTicketRow {
  id: string;
  householdId: string;
  kind: string;
  status: string;
  subject: string;
  body: string;
  requestedDate: Date | null;
  partySize: number | null;
  theme: string | null;
  slaDueAt: Date | null;
  assignedToUserId: string | null;
  escalationPath: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AssignmentRow {
  readonly householdId: string;
  readonly primaryConciergeUserId: string;
  readonly status: 'active' | 'ended';
  readonly deletedAt: Date | null;
}

let idCounter = 0;

class FakePrisma {
  public assignments: AssignmentRow[] = [];
  public tickets: ConciergeTicketRow[] = [];

  get conciergeAssignment(): {
    findFirst: (args: {
      where: Record<string, unknown>;
    }) => Promise<{ primaryConciergeUserId: string } | null>;
  } {
    return {
      findFirst: async (args) => {
        const match = this.assignments.find((row) =>
          Object.entries(args.where).every(
            ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
          ),
        );
        return match === undefined
          ? null
          : { primaryConciergeUserId: match.primaryConciergeUserId };
      },
    };
  }

  get conciergeTicket(): {
    create: (args: { data: Record<string, unknown> }) => Promise<ConciergeTicketRow>;
  } {
    return {
      create: async (args) => {
        idCounter += 1;
        const now = new Date('2026-06-01T09:00:00.000Z');
        const data = args.data;
        const row: ConciergeTicketRow = {
          id: `tk_${idCounter}`,
          householdId: String(data['householdId']),
          kind: String(data['kind']),
          status: String(data['status']),
          subject: String(data['subject']),
          body: String(data['body']),
          requestedDate: (data['requestedDate'] as Date | null) ?? null,
          partySize: (data['partySize'] as number | null) ?? null,
          theme: (data['theme'] as string | null) ?? null,
          slaDueAt: (data['slaDueAt'] as Date | null) ?? null,
          assignedToUserId: (data['assignedToUserId'] as string | null) ?? null,
          escalationPath: String(data['escalationPath']),
          createdAt: now,
          updatedAt: now,
        };
        this.tickets.push(row);
        return row;
      },
    };
  }
}

class FakePagerDuty {
  public calls: PagerDutyEnqueueInput[] = [];
  constructor(private readonly result: PagerDutyEnqueueResult = { kind: 'sent', dedupKey: 'x' }) {}
  async enqueue(input: PagerDutyEnqueueInput): Promise<PagerDutyEnqueueResult> {
    this.calls.push(input);
    if (this.result.kind === 'sent') return { kind: 'sent', dedupKey: input.dedupKey };
    return this.result;
  }
}

function buildService(prisma: FakePrisma, pagerDuty: FakePagerDuty): EmergencyService {
  return new EmergencyService(
    prisma as unknown as PrismaService,
    pagerDuty as unknown as PagerDutyClient,
  );
}

describe('EmergencyService.triggerEmergency', () => {
  it('opens a high-severity escalated emergency ticket on the on-call path', async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty();
    const service = buildService(prisma, pagerDuty);

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: null,
    });

    expect(ticket.kind).toBe('emergency_assistance');
    expect(ticket.status).toBe('escalated');
    expect(ticket.escalationPath).toBe('emergency_on_call');
    expect(prisma.tickets).toHaveLength(1);
  });

  it('stamps the tightened 1-hour SLA', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma, new FakePagerDuty());

    const before = Date.now();
    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'safety',
      note: null,
    });

    expect(ticket.slaDueAt).not.toBeNull();
    const slaMs = Date.parse(ticket.slaDueAt as string);
    expect(Math.abs(slaMs - (before + 60 * 60 * 1000))).toBeLessThan(60_000);
  });

  it('derives the subject from the category', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma, new FakePagerDuty());

    const medical = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: null,
    });
    const other = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'other',
      note: null,
    });

    expect(medical.subject).toBe('Emergency assistance — Medical concern');
    expect(other.subject).toBe('Emergency assistance');
  });

  it('uses the note as the body when provided', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma, new FakePagerDuty());

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'urgent_need',
      note: 'Out of her heart medication.',
    });

    expect(ticket.body).toBe('Out of her heart medication.');
  });

  it('falls back to a default body when no note is provided', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma, new FakePagerDuty());

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'other',
      note: null,
    });

    expect(ticket.body).toContain('No additional details were provided');
  });

  it('routes to the household active primary concierge when one is assigned', async () => {
    const prisma = new FakePrisma();
    prisma.assignments.push({
      householdId: 'hh_1',
      primaryConciergeUserId: 'user_primary',
      status: 'active',
      deletedAt: null,
    });
    const service = buildService(prisma, new FakePagerDuty());

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: null,
    });

    expect(ticket.assignedToUserId).toBe('user_primary');
    // Still escalated even when routed — an emergency bypasses the ramp.
    expect(ticket.status).toBe('escalated');
  });

  it('lands unassigned when the household has no dedicated concierge', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma, new FakePagerDuty());

    const ticket = await service.triggerEmergency({
      householdId: 'hh_none',
      category: 'safety',
      note: null,
    });

    expect(ticket.assignedToUserId).toBeNull();
    expect(ticket.status).toBe('escalated');
  });
});

describe('EmergencyService PagerDuty paging', () => {
  it('pages on-call with the ticket id as the dedup key and critical severity', async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty();
    const service = buildService(prisma, pagerDuty);

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: 'secret detail',
    });

    expect(pagerDuty.calls).toHaveLength(1);
    const call = pagerDuty.calls[0]!;
    expect(call.dedupKey).toBe(`concierge-emergency-${ticket.id}`);
    expect(call.severity).toBe('critical');
    expect(call.customDetails['ticketId']).toBe(ticket.id);
    expect(call.customDetails['category']).toBe('medical');
    expect(call.customDetails['householdId']).toBe('hh_1');
  });

  it('never includes the family free-text note in the PagerDuty payload (privacy)', async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty();
    const service = buildService(prisma, pagerDuty);

    await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: 'PII: Mom fell',
    });

    const call = pagerDuty.calls[0]!;
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain('PII: Mom fell');
  });

  it('still creates the ticket when paging is unconfigured (degrades gracefully)', async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty({ kind: 'skipped_unconfigured' });
    const service = buildService(prisma, pagerDuty);

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'safety',
      note: null,
    });

    expect(ticket.status).toBe('escalated');
    expect(prisma.tickets).toHaveLength(1);
  });

  it('still returns the durable ticket when paging fails (never rolls back)', async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty({ kind: 'failed', detail: 'pagerduty 502' });
    const service = buildService(prisma, pagerDuty);

    const ticket = await service.triggerEmergency({
      householdId: 'hh_1',
      category: 'medical',
      note: null,
    });

    expect(ticket.id).toBeTruthy();
    expect(ticket.status).toBe('escalated');
    expect(prisma.tickets).toHaveLength(1);
  });

  it('records the assigned concierge id in the page custom details', async () => {
    const prisma = new FakePrisma();
    prisma.assignments.push({
      householdId: 'hh_1',
      primaryConciergeUserId: 'user_primary',
      status: 'active',
      deletedAt: null,
    });
    const pagerDuty = new FakePagerDuty();
    const service = buildService(prisma, pagerDuty);

    await service.triggerEmergency({ householdId: 'hh_1', category: 'medical', note: null });

    expect(pagerDuty.calls[0]!.customDetails['assignedConciergeUserId']).toBe('user_primary');
  });

  it("marks the page detail 'unassigned' when the household has no concierge", async () => {
    const prisma = new FakePrisma();
    const pagerDuty = new FakePagerDuty();
    const service = buildService(prisma, pagerDuty);

    await service.triggerEmergency({ householdId: 'hh_none', category: 'other', note: null });

    expect(pagerDuty.calls[0]!.customDetails['assignedConciergeUserId']).toBe('unassigned');
  });
});
