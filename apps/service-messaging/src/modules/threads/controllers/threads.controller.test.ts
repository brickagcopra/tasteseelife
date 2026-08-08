import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type {
  AddThreadParticipantRequest,
  CreateThreadRequest,
  ListThreadsInboxQuery,
  ThreadInboxEntry,
  ThreadWithParticipantsRecord,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '../services/result';
import type { ThreadsService } from '../services/threads.service';

import { ThreadsController } from './threads.controller';

/**
 * Unit tests for {@link ThreadsController} (TS-070-followup-2).
 *
 * The collaborator {@link ThreadsService} is fully stubbed; these tests pin
 * the HTTP boundary behaviour: actor resolution from the access-token
 * `requestContext`, the 401 when it's missing, the response-schema parse, and
 * the roster-gate-failure → RFC 7807 status mapping (404 / 409 / 403).
 */

const CTX: RequestContext = {
  userId: 'usr_caller',
  roles: [],
  tenantScope: { kind: 'global' },
} as unknown as RequestContext;

function reqWith(ctx: RequestContext | undefined): RequestWithContext {
  return { requestContext: ctx } as unknown as RequestWithContext;
}

function threadRecord(
  overrides: Partial<ThreadWithParticipantsRecord> = {},
): ThreadWithParticipantsRecord {
  return {
    id: 'thr_1',
    kind: 'household',
    householdId: 'hh_1',
    bookingId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    participants: [
      {
        threadId: 'thr_1',
        userId: 'usr_caller',
        role: 'member',
        joinedAt: '2026-01-01T00:00:00.000Z',
        lastReadMessageId: null,
      },
    ],
    ...overrides,
  };
}

function inboxEntry(overrides: Partial<ThreadInboxEntry> = {}): ThreadInboxEntry {
  return {
    id: 'thr_1',
    kind: 'household',
    householdId: 'hh_1',
    bookingId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    myRole: 'member',
    myLastReadMessageId: null,
    participantCount: 1,
    ...overrides,
  };
}

function makeController(stub: Partial<ThreadsService>): {
  controller: ThreadsController;
  stub: Partial<ThreadsService>;
} {
  const controller = new ThreadsController(stub as ThreadsService);
  return { controller, stub };
}

describe('ThreadsController.create', () => {
  it('passes the authenticated creator as ensureMemberUserId and returns the parsed thread', async () => {
    const createThread = vi.fn().mockResolvedValue(threadRecord());
    const { controller } = makeController({ createThread });

    const body: CreateThreadRequest = {
      kind: 'household',
      householdId: 'hh_1',
      participants: [{ userId: 'usr_obs', role: 'observer' }],
    } as CreateThreadRequest;

    const response = await controller.create(body, reqWith(CTX));

    expect(response.thread.id).toBe('thr_1');
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ ensureMemberUserId: 'usr_caller', householdId: 'hh_1' }),
    );
  });

  it('throws 401 when the request carries no context', async () => {
    const { controller } = makeController({ createThread: vi.fn() });
    await expect(
      controller.create({ kind: 'peer_thread' } as CreateThreadRequest, reqWith(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ThreadsController.listMine', () => {
  it('scopes the inbox read to the caller and returns the parsed list', async () => {
    const listInbox = vi.fn().mockResolvedValue([inboxEntry()]);
    const { controller } = makeController({ listInbox });

    const query: ListThreadsInboxQuery = { limit: 50, includeArchived: false };
    const response = await controller.listMine(query, reqWith(CTX));

    expect(response.threads).toHaveLength(1);
    expect(listInbox).toHaveBeenCalledWith({
      userId: 'usr_caller',
      limit: 50,
      includeArchived: false,
    });
  });
});

describe('ThreadsController.detail', () => {
  it('returns the parsed detail for a member', async () => {
    const getThreadDetailForMember = vi.fn().mockResolvedValue(threadRecord());
    const { controller } = makeController({ getThreadDetailForMember });

    const response = await controller.detail('thr_1', reqWith(CTX));
    expect(response.thread.id).toBe('thr_1');
    expect(getThreadDetailForMember).toHaveBeenCalledWith('thr_1', 'usr_caller');
  });

  it('throws 404 when the service returns null (non-member or missing)', async () => {
    const getThreadDetailForMember = vi.fn().mockResolvedValue(null);
    const { controller } = makeController({ getThreadDetailForMember });

    await expect(controller.detail('thr_x', reqWith(CTX))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ThreadsController.addParticipant', () => {
  it('returns the parsed add result on success', async () => {
    const addParticipant = vi.fn().mockResolvedValue(
      ok({
        participant: {
          threadId: 'thr_1',
          userId: 'usr_new',
          role: 'observer',
          joinedAt: '2026-01-01T00:00:00.000Z',
          lastReadMessageId: null,
        },
        outcome: 'added',
      }),
    );
    const { controller } = makeController({ addParticipant });

    const body: AddThreadParticipantRequest = { userId: 'usr_new', role: 'observer' };
    const response = await controller.addParticipant('thr_1', body, reqWith(CTX));

    expect(response.outcome).toBe('added');
    expect(addParticipant).toHaveBeenCalledWith({
      threadId: 'thr_1',
      requesterUserId: 'usr_caller',
      userId: 'usr_new',
      role: 'observer',
    });
  });

  it('maps not_a_participant → 404', async () => {
    const addParticipant = vi.fn().mockResolvedValue(err({ reason: 'not_a_participant' }));
    const { controller } = makeController({ addParticipant });
    await expect(
      controller.addParticipant('thr_1', { userId: 'u', role: 'member' }, reqWith(CTX)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps thread_archived → 409', async () => {
    const addParticipant = vi.fn().mockResolvedValue(err({ reason: 'thread_archived' }));
    const { controller } = makeController({ addParticipant });
    await expect(
      controller.addParticipant('thr_1', { userId: 'u', role: 'member' }, reqWith(CTX)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps forbidden_role → 403', async () => {
    const addParticipant = vi.fn().mockResolvedValue(err({ reason: 'forbidden_role' }));
    const { controller } = makeController({ addParticipant });
    await expect(
      controller.addParticipant('thr_1', { userId: 'u', role: 'member' }, reqWith(CTX)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ThreadsController.removeParticipant', () => {
  it('returns the parsed remove result on success', async () => {
    const removeParticipant = vi
      .fn()
      .mockResolvedValue(ok({ outcome: 'removed', threadId: 'thr_1', userId: 'usr_gone' }));
    const { controller } = makeController({ removeParticipant });

    const response = await controller.removeParticipant('thr_1', 'usr_gone', reqWith(CTX));
    expect(response.outcome).toBe('removed');
    expect(removeParticipant).toHaveBeenCalledWith({
      threadId: 'thr_1',
      requesterUserId: 'usr_caller',
      userId: 'usr_gone',
    });
  });

  it('maps forbidden_role → 403', async () => {
    const removeParticipant = vi.fn().mockResolvedValue(err({ reason: 'forbidden_role' }));
    const { controller } = makeController({ removeParticipant });
    await expect(
      controller.removeParticipant('thr_1', 'usr_x', reqWith(CTX)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
