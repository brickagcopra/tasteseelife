import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { ConciergeTicketNoteRecord, ConciergeTicketRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import {
  OpsConsoleService,
  type AddNoteOutcome,
  type EscalateOutcome,
  type TransitionOutcome,
} from '../services/ops-console.service';
import { OpsConsoleController } from './ops-console.controller';

const T0 = '2026-06-01T09:00:00.000Z';

function buildTicket(overrides: Partial<ConciergeTicketRecord> = {}): ConciergeTicketRecord {
  return {
    id: 'tk_1',
    householdId: 'hh_1',
    kind: 'holiday_dinner',
    status: 'open',
    subject: 'Thanksgiving supper',
    body: 'Small traditional turkey dinner.',
    requestedDate: null,
    partySize: null,
    theme: null,
    slaDueAt: T0,
    assignedToUserId: null,
    escalationPath: 'standard',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function buildNote(overrides: Partial<ConciergeTicketNoteRecord> = {}): ConciergeTicketNoteRecord {
  return {
    id: 'note_1',
    ticketId: 'tk_1',
    authorUserId: 'user_ops',
    body: 'Reached out to confirm the guest count.',
    createdAt: T0,
    ...overrides,
  };
}

interface FakeService {
  listQueue: ReturnType<typeof vi.fn>;
  getTicketDetail: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
  escalate: ReturnType<typeof vi.fn>;
  addNote: ReturnType<typeof vi.fn>;
}

function buildController(overrides: Partial<FakeService> = {}): {
  controller: OpsConsoleController;
  service: FakeService;
} {
  const service: FakeService = {
    listQueue: vi.fn(async (): Promise<readonly ConciergeTicketRecord[]> => [buildTicket()]),
    getTicketDetail: vi.fn(
      async (): Promise<{
        ticket: ConciergeTicketRecord;
        notes: readonly ConciergeTicketNoteRecord[];
      } | null> => ({ ticket: buildTicket(), notes: [buildNote()] }),
    ),
    transition: vi.fn(
      async (): Promise<TransitionOutcome> => ({
        ok: true,
        ticket: buildTicket({ status: 'in_progress' }),
      }),
    ),
    escalate: vi.fn(
      async (): Promise<EscalateOutcome> => ({
        ok: true,
        ticket: buildTicket({ status: 'escalated', escalationPath: 'trust_safety' }),
      }),
    ),
    addNote: vi.fn(async (): Promise<AddNoteOutcome> => ({ ok: true, note: buildNote() })),
    ...overrides,
  };
  const controller = new OpsConsoleController(service as unknown as OpsConsoleService);
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

describe('OpsConsoleController.listQueue', () => {
  it('forwards the query filters and returns the wrapped tickets', async () => {
    const { controller, service } = buildController();
    const result = await controller.listQueue({
      status: 'escalated',
      escalationPath: 'trust_safety',
      kind: 'memory_meal',
      householdId: 'hh_9',
      limit: 25,
    });
    expect(result.tickets).toHaveLength(1);
    expect(service.listQueue).toHaveBeenCalledWith({
      status: 'escalated',
      escalationPath: 'trust_safety',
      kind: 'memory_meal',
      householdId: 'hh_9',
      limit: 25,
    });
  });
});

describe('OpsConsoleController.getTicket', () => {
  it('returns the ticket + notes', async () => {
    const { controller } = buildController();
    const result = await controller.getTicket('tk_1');
    expect(result.ticket.id).toBe('tk_1');
    expect(result.notes).toHaveLength(1);
  });

  it('throws 404 when the ticket does not resolve', async () => {
    const { controller } = buildController({
      getTicketDetail: vi.fn(async () => null),
    });
    await expect(controller.getTicket('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OpsConsoleController.transition', () => {
  it('applies the transition and stamps the actor from the token', async () => {
    const { controller, service } = buildController();
    const result = await controller.transition(
      'tk_1',
      { targetStatus: 'in_progress', note: 'Starting work.' },
      opsRequest('user_actor'),
    );
    expect(result.ticket.status).toBe('in_progress');
    expect(service.transition).toHaveBeenCalledWith({
      ticketId: 'tk_1',
      actorUserId: 'user_actor',
      targetStatus: 'in_progress',
      note: 'Starting work.',
    });
  });

  it('throws 404 on not_found', async () => {
    const { controller } = buildController({
      transition: vi.fn(
        async (): Promise<TransitionOutcome> => ({ ok: false, reason: 'not_found' }),
      ),
    });
    await expect(
      controller.transition('nope', { targetStatus: 'in_progress' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 on invalid_transition', async () => {
    const { controller } = buildController({
      transition: vi.fn(
        async (): Promise<TransitionOutcome> => ({
          ok: false,
          reason: 'invalid_transition',
          from: 'open',
          to: 'resolved',
        }),
      ),
    });
    await expect(
      controller.transition('tk_1', { targetStatus: 'resolved' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 401 when the request carries no context', async () => {
    const { controller } = buildController();
    await expect(
      controller.transition('tk_1', { targetStatus: 'in_progress' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('OpsConsoleController.escalate', () => {
  it('escalates and returns the updated ticket', async () => {
    const { controller, service } = buildController();
    const result = await controller.escalate(
      'tk_1',
      { escalationPath: 'trust_safety', note: 'Welfare concern.' },
      opsRequest('user_actor'),
    );
    expect(result.ticket.escalationPath).toBe('trust_safety');
    expect(service.escalate).toHaveBeenCalledWith({
      ticketId: 'tk_1',
      actorUserId: 'user_actor',
      escalationPath: 'trust_safety',
      note: 'Welfare concern.',
    });
  });

  it('throws 404 on not_found', async () => {
    const { controller } = buildController({
      escalate: vi.fn(async (): Promise<EscalateOutcome> => ({ ok: false, reason: 'not_found' })),
    });
    await expect(
      controller.escalate('nope', { escalationPath: 'ops_manager' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 when escalating a terminal ticket', async () => {
    const { controller } = buildController({
      escalate: vi.fn(
        async (): Promise<EscalateOutcome> => ({
          ok: false,
          reason: 'terminal',
          status: 'resolved',
        }),
      ),
    });
    await expect(
      controller.escalate('tk_1', { escalationPath: 'ops_manager' }, opsRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OpsConsoleController.addNote', () => {
  it('appends the note and stamps the actor', async () => {
    const { controller, service } = buildController();
    const result = await controller.addNote(
      'tk_1',
      { body: 'Confirmed with the chef.' },
      opsRequest('user_actor'),
    );
    expect(result.note.id).toBe('note_1');
    expect(service.addNote).toHaveBeenCalledWith({
      ticketId: 'tk_1',
      actorUserId: 'user_actor',
      body: 'Confirmed with the chef.',
    });
  });

  it('throws 404 on not_found', async () => {
    const { controller } = buildController({
      addNote: vi.fn(async (): Promise<AddNoteOutcome> => ({ ok: false, reason: 'not_found' })),
    });
    await expect(
      controller.addNote('nope', { body: 'orphan' }, opsRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
