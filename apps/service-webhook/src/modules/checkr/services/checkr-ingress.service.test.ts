import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { BackgroundCheckDispatchService } from './background-check-dispatch.service';
import { CheckrIngressService } from './checkr-ingress.service';
import type { CheckrEventEnvelope } from './checkr-webhook-verifier.service';

function makeEnvelope(overrides: Partial<CheckrEventEnvelope> = {}): CheckrEventEnvelope {
  return {
    id: 'evt_abc',
    type: 'report.completed',
    accountId: 'acc_xyz',
    object: {
      id: 'rep_abc',
      kind: 'report',
      status: 'clear',
      candidateId: 'cand_abc',
    },
    createdSeconds: 1_700_000_000,
    ...overrides,
  };
}

interface FakePrisma {
  readonly checkrProcessedEvent: {
    readonly create: ReturnType<typeof vi.fn>;
    readonly update: ReturnType<typeof vi.fn>;
  };
}

function makePrisma(): FakePrisma {
  return {
    checkrProcessedEvent: {
      create: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeIngress(args: {
  readonly prisma: FakePrisma;
  readonly dispatcher?: Partial<BackgroundCheckDispatchService>;
}): CheckrIngressService {
  const dispatcher = (args.dispatcher ?? {
    dispatch: vi.fn().mockResolvedValue(null),
    markDispatched: vi.fn().mockResolvedValue(undefined),
  }) as BackgroundCheckDispatchService;
  return new CheckrIngressService(args.prisma as unknown as PrismaService, dispatcher);
}

describe('CheckrIngressService.persist', () => {
  it('returns `persisted` and writes the row on the happy path', async () => {
    const prisma = makePrisma();
    const ingress = makeIngress({ prisma });
    const outcome = await ingress.persist({
      event: makeEnvelope(),
      payload: { id: 'evt_abc', type: 'report.completed' },
      verifiedAt: new Date('2026-05-11T12:00:00Z'),
    });
    expect(outcome).toBe('persisted');
    expect(prisma.checkrProcessedEvent.create).toHaveBeenCalledTimes(1);
    const args = prisma.checkrProcessedEvent.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data['eventId']).toBe('evt_abc');
    expect(args.data['eventType']).toBe('report.completed');
    expect(args.data['accountId']).toBe('acc_xyz');
    expect(args.data['objectKind']).toBe('report');
    expect(args.data['objectId']).toBe('rep_abc');
  });

  it('returns `duplicate` when the unique-constraint violation fires', async () => {
    const prisma = makePrisma();
    const p2002 = Object.assign(new Error('p2002'), {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
    });
    prisma.checkrProcessedEvent.create.mockRejectedValueOnce(p2002);
    const ingress = makeIngress({ prisma });
    const outcome = await ingress.persist({
      event: makeEnvelope(),
      payload: {},
      verifiedAt: new Date(),
    });
    expect(outcome).toBe('duplicate');
  });

  it('rethrows non-P2002 DB errors', async () => {
    const prisma = makePrisma();
    prisma.checkrProcessedEvent.create.mockRejectedValueOnce(new Error('unrelated db error'));
    const ingress = makeIngress({ prisma });
    await expect(
      ingress.persist({
        event: makeEnvelope(),
        payload: {},
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow('unrelated db error');
  });

  it('dispatches and stamps `dispatched_at` for `report.*` events', async () => {
    const prisma = makePrisma();
    const dispatchMock = vi.fn().mockResolvedValue('applied' as const);
    const markMock = vi.fn().mockResolvedValue(undefined);
    const ingress = makeIngress({
      prisma,
      dispatcher: {
        dispatch: dispatchMock,
        markDispatched: markMock,
      } as Partial<BackgroundCheckDispatchService>,
    });
    await ingress.persist({
      event: makeEnvelope(),
      payload: {},
      verifiedAt: new Date(),
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(markMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispatch for non-report.* events', async () => {
    const prisma = makePrisma();
    const dispatchMock = vi.fn().mockResolvedValue(null);
    const ingress = makeIngress({
      prisma,
      dispatcher: {
        dispatch: dispatchMock,
        markDispatched: vi.fn(),
      } as Partial<BackgroundCheckDispatchService>,
    });
    await ingress.persist({
      event: makeEnvelope({
        type: 'candidate.created',
        object: {
          id: 'cand_abc',
          kind: 'candidate',
          status: null,
          candidateId: null,
        },
      }),
      payload: {},
      verifiedAt: new Date(),
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does NOT stamp `dispatched_at` when the dispatch returns null', async () => {
    const prisma = makePrisma();
    const dispatchMock = vi.fn().mockResolvedValue(null);
    const markMock = vi.fn().mockResolvedValue(undefined);
    const ingress = makeIngress({
      prisma,
      dispatcher: {
        dispatch: dispatchMock,
        markDispatched: markMock,
      } as Partial<BackgroundCheckDispatchService>,
    });
    await ingress.persist({
      event: makeEnvelope(),
      payload: {},
      verifiedAt: new Date(),
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(markMock).not.toHaveBeenCalled();
  });

  it('does NOT call the dispatcher on the duplicate path', async () => {
    const prisma = makePrisma();
    const p2002 = Object.assign(new Error('p2002'), {
      code: 'P2002',
      name: 'PrismaClientKnownRequestError',
    });
    prisma.checkrProcessedEvent.create.mockRejectedValueOnce(p2002);
    const dispatchMock = vi.fn().mockResolvedValue(null);
    const ingress = makeIngress({
      prisma,
      dispatcher: {
        dispatch: dispatchMock,
        markDispatched: vi.fn(),
      } as Partial<BackgroundCheckDispatchService>,
    });
    await ingress.persist({
      event: makeEnvelope(),
      payload: {},
      verifiedAt: new Date(),
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
