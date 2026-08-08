import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { ThreadMembershipService } from './thread-membership.service';

interface FakeFindUniqueArgs {
  readonly where: {
    readonly threadId_userId: { readonly threadId: string; readonly userId: string };
  };
}

interface FakeRow {
  readonly threadId: string;
  readonly userId: string;
  readonly role: 'member' | 'observer' | 'concierge' | 'moderator';
  readonly thread: { readonly archivedAt: Date | null; readonly kind: string };
}

function makePrismaStub(row: FakeRow | null): {
  prisma: PrismaService;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_args: FakeFindUniqueArgs) => row);
  const prisma = {
    threadParticipant: { findUnique: spy },
  } as unknown as PrismaService;
  return { prisma, spy };
}

describe('ThreadMembershipService.resolveMembership', () => {
  it('returns the membership row for an active participant on an active thread', async () => {
    const { prisma } = makePrismaStub({
      threadId: 'thr_1',
      userId: 'usr_1',
      role: 'member',
      thread: { archivedAt: null, kind: 'household' },
    });
    const svc = new ThreadMembershipService(prisma);
    const result = await svc.resolveMembership('thr_1', 'usr_1');
    expect(result).toEqual({
      threadId: 'thr_1',
      userId: 'usr_1',
      kind: 'household',
      role: 'member',
      threadArchivedAt: null,
    });
  });

  it('returns null when no participant row exists', async () => {
    const { prisma, spy } = makePrismaStub(null);
    const svc = new ThreadMembershipService(prisma);
    const result = await svc.resolveMembership('thr_2', 'usr_2');
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith({
      where: { threadId_userId: { threadId: 'thr_2', userId: 'usr_2' } },
      select: {
        threadId: true,
        userId: true,
        role: true,
        thread: { select: { archivedAt: true, kind: true } },
      },
    });
  });

  it('surfaces the archived-at timestamp so the gateway can refuse the join', async () => {
    const archivedAt = new Date('2026-05-01T00:00:00Z');
    const { prisma } = makePrismaStub({
      threadId: 'thr_3',
      userId: 'usr_3',
      role: 'observer',
      thread: { archivedAt, kind: 'booking' },
    });
    const svc = new ThreadMembershipService(prisma);
    const result = await svc.resolveMembership('thr_3', 'usr_3');
    expect(result).not.toBeNull();
    expect(result?.threadArchivedAt).toEqual(archivedAt);
    expect(result?.role).toBe('observer');
  });

  it('surfaces concierge role unchanged', async () => {
    const { prisma } = makePrismaStub({
      threadId: 'thr_4',
      userId: 'usr_4',
      role: 'concierge',
      thread: { archivedAt: null, kind: 'concierge' },
    });
    const svc = new ThreadMembershipService(prisma);
    const result = await svc.resolveMembership('thr_4', 'usr_4');
    expect(result?.role).toBe('concierge');
  });

  it('surfaces the peer_thread kind + moderator role (TS-209)', async () => {
    const { prisma } = makePrismaStub({
      threadId: 'thr_5',
      userId: 'usr_5',
      role: 'moderator',
      thread: { archivedAt: null, kind: 'peer_thread' },
    });
    const svc = new ThreadMembershipService(prisma);
    const result = await svc.resolveMembership('thr_5', 'usr_5');
    expect(result?.kind).toBe('peer_thread');
    expect(result?.role).toBe('moderator');
    expect(result?.threadArchivedAt).toBeNull();
  });
});
