import 'reflect-metadata';

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AuditActorContext, AuditEmitter } from '@taste-and-see/nest-audit';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  DataSubjectRequestsService,
  resolveSubject,
  type DataSubjectRequestRow,
} from './data-subject-requests.service';

/**
 * Unit tests for the data-subject request lifecycle (TS-309a).
 *
 * The load-bearing assertions, in the order they matter:
 *   - **a request naming SOMEBODY ELSE never reaches `in_progress` on its
 *     own.** That is the whole reason requester and subject are modelled
 *     apart: a family payer asking for a senior's data is a legitimate
 *     request AND an unverified one, and the platform's consent model lives
 *     in the gap;
 *   - a self-service request IS verified, by the session, and the trail says
 *     so rather than being blank;
 *   - the statutory clock is stamped once at intake and only moves through an
 *     explicit, reasoned, once-only extension;
 *   - a duplicate open request does not start a second clock;
 *   - withdrawal belongs to the requester alone, and someone else's request
 *     404s rather than 403s;
 *   - **the audit diff carries no free text** — the audit stream is
 *     replicated more widely than this table.
 */

const NOW = new Date('2026-07-26T12:00:00.000Z');
const DUE = new Date('2026-09-09T12:00:00.000Z'); // NOW + 45 days

const ACTOR: AuditActorContext = {
  actorUserId: 'usr_requester',
  actorRole: null,
  actorTenantScopeType: 'global',
  actorTenantScopeId: null,
  ip: null,
  userAgent: null,
  requestId: null,
  traceId: null,
};

interface AuditCall {
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
}

interface Harness {
  readonly service: DataSubjectRequestsService;
  readonly rows: Record<string, unknown>[];
  readonly audits: AuditCall[];
}

function baseRow(overrides: Partial<DataSubjectRequestRow> = {}): DataSubjectRequestRow {
  return {
    id: 'dsr_1',
    requesterUserId: 'usr_requester',
    subjectKind: 'user',
    subjectId: 'usr_requester',
    selfService: true,
    kind: 'access',
    status: 'received',
    note: null,
    receivedAt: NOW,
    dueAt: DUE,
    extendedAt: null,
    extensionReason: null,
    verifiedAt: null,
    verifiedByUserId: null,
    verificationMethod: null,
    fulfilledAt: null,
    refusedAt: null,
    refusalReason: null,
    refusalNote: null,
    withdrawnAt: null,
    ...overrides,
  };
}

function makeHarness(
  options: {
    readonly existing?: DataSubjectRequestRow | null;
    readonly openDuplicate?: boolean;
  } = {},
): Harness {
  const rows: Record<string, unknown>[] = [];
  const audits: AuditCall[] = [];
  let current: DataSubjectRequestRow | null = options.existing ?? null;

  const model = {
    findFirst: async () => (options.openDuplicate === true ? { id: 'dsr_existing' } : null),
    findUnique: async () => current,
    findMany: async () => (current === null ? [] : [current]),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      rows.push(data);
      current = baseRow({
        ...(data as Partial<DataSubjectRequestRow>),
        id: 'dsr_1',
      });
      return current;
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      current = baseRow({ ...(current ?? baseRow()), ...(data as Partial<DataSubjectRequestRow>) });
      return current;
    },
  };

  const prisma = {
    dataSubjectRequest: model,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ dataSubjectRequest: model }),
  } as unknown as PrismaService;

  const audit = {
    emit: async (_tx: unknown, _actor: unknown, descriptor: AuditCall) => {
      audits.push(descriptor);
    },
  } as unknown as AuditEmitter;

  return { service: new DataSubjectRequestsService(prisma, audit), rows, audits };
}

describe('resolveSubject', () => {
  it('defaults to the requester — making someone type their own id invites a typo about a stranger', () => {
    expect(resolveSubject({ requesterUserId: 'usr_1', kind: 'access' })).toEqual({
      kind: 'user',
      id: 'usr_1',
    });
  });

  it('honours an explicitly named subject', () => {
    expect(
      resolveSubject({
        requesterUserId: 'usr_1',
        kind: 'access',
        subjectKind: 'senior',
        subjectId: 'sen_9',
      }),
    ).toEqual({ kind: 'senior', id: 'sen_9' });
  });
});

describe('DataSubjectRequestsService.createRequest', () => {
  it('verifies a self-service request via the session and moves it to in_progress', async () => {
    const harness = makeHarness();

    const row = await harness.service.createRequest(
      { requesterUserId: 'usr_requester', kind: 'access' },
      ACTOR,
      NOW,
    );

    expect(row.selfService).toBe(true);
    expect(row.status).toBe('in_progress');
    expect(row.verifiedByUserId).toBe('usr_requester');
    // Not blank: the trail records what the proof actually was.
    expect(row.verificationMethod).toContain('MFA-verified session');
  });

  it('LEAVES A REQUEST ABOUT SOMEBODY ELSE unverified, at `received`', async () => {
    // The single most important assertion in the file. A family payer
    // asking about a senior is legitimate AND unverified, and nothing
    // automatic may close that gap.
    const harness = makeHarness();

    const row = await harness.service.createRequest(
      {
        requesterUserId: 'usr_payer',
        kind: 'access',
        subjectKind: 'senior',
        subjectId: 'sen_9',
      },
      ACTOR,
      NOW,
    );

    expect(row.selfService).toBe(false);
    expect(row.status).toBe('received');
    expect(row.verifiedAt).toBeNull();
  });

  it('inserts at `received` even for self-service — the edge is walked, not skipped', async () => {
    const harness = makeHarness();

    await harness.service.createRequest(
      { requesterUserId: 'usr_requester', kind: 'access' },
      ACTOR,
      NOW,
    );

    expect(harness.rows[0]?.['status']).toBe('received');
  });

  it('stamps the statutory deadline once, at intake', async () => {
    const harness = makeHarness();

    await harness.service.createRequest(
      { requesterUserId: 'usr_requester', kind: 'access' },
      ACTOR,
      NOW,
    );

    expect((harness.rows[0]?.['dueAt'] as Date).toISOString()).toBe(DUE.toISOString());
    expect((harness.rows[0]?.['receivedAt'] as Date).toISOString()).toBe(NOW.toISOString());
  });

  it('refuses a duplicate open request rather than starting a second clock', async () => {
    // A second identical ask is not new information, and a second clock is
    // how a platform misses a deadline it already met.
    const harness = makeHarness({ openDuplicate: true });

    await expect(
      harness.service.createRequest(
        { requesterUserId: 'usr_requester', kind: 'access' },
        ACTOR,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts an erasure request even though execution is blocked', async () => {
    const harness = makeHarness();

    const row = await harness.service.createRequest(
      { requesterUserId: 'usr_requester', kind: 'erasure' },
      ACTOR,
      NOW,
    );

    expect(row.kind).toBe('erasure');
  });

  it('audits the filing, and the self-service verification separately', async () => {
    const harness = makeHarness();

    await harness.service.createRequest(
      { requesterUserId: 'usr_requester', kind: 'access' },
      ACTOR,
      NOW,
    );

    expect(harness.audits.map((a) => a.action)).toEqual([
      'data_subject_request:file',
      'data_subject_request:verify',
    ]);
  });

  it('keeps the requester’s free-text note OUT of the audit diff', async () => {
    // The audit stream is replicated to Cassandra and read by more surfaces
    // than this table; a note may name a senior and describe them.
    const harness = makeHarness();

    await harness.service.createRequest(
      {
        requesterUserId: 'usr_requester',
        kind: 'access',
        note: 'my mother is in hospital and I need her visit records',
      },
      ACTOR,
      NOW,
    );

    const serialised = JSON.stringify(harness.audits);
    expect(serialised).not.toContain('hospital');
    expect(serialised).not.toContain('note');
  });
});

describe('DataSubjectRequestsService.verify', () => {
  it('walks a third-party request to in_progress and records who and how', async () => {
    const harness = makeHarness({
      existing: baseRow({ selfService: false, subjectKind: 'senior', subjectId: 'sen_9' }),
    });

    const row = await harness.service.verify(
      'dsr_1',
      'call-back to the number on file',
      ACTOR,
      'usr_ops',
      NOW,
    );

    expect(row.status).toBe('in_progress');
    expect(row.verifiedByUserId).toBe('usr_ops');
    expect(row.verificationMethod).toBe('call-back to the number on file');
  });

  it('REFUSES to re-verify a self-service request', async () => {
    // Accepting one would let an operator overwrite the session-based trail
    // with a weaker human-asserted claim.
    const harness = makeHarness({ existing: baseRow({ selfService: true }) });

    await expect(
      harness.service.verify('dsr_1', 'I know them', ACTOR, 'usr_ops', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to verify a request that is already closed', async () => {
    const harness = makeHarness({
      existing: baseRow({ selfService: false, status: 'withdrawn' }),
    });

    await expect(
      harness.service.verify('dsr_1', 'call-back', ACTOR, 'usr_ops', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an unknown id', async () => {
    const harness = makeHarness({ existing: null });

    await expect(
      harness.service.verify('nope', 'call-back', ACTOR, 'usr_ops', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DataSubjectRequestsService.refuse', () => {
  it('refuses from in_progress — a retention rule can surface after work began', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'in_progress' }) });

    const row = await harness.service.refuse('dsr_1', 'retention_required', undefined, ACTOR, NOW);

    expect(row.status).toBe('refused');
    expect(row.refusalReason).toBe('retention_required');
  });

  it('refuses from received', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'received' }) });

    const row = await harness.service.refuse(
      'dsr_1',
      'identity_not_verified',
      undefined,
      ACTOR,
      NOW,
    );

    expect(row.status).toBe('refused');
  });

  it('cannot refuse an already-closed request', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'fulfilled' }) });

    await expect(
      harness.service.refuse('dsr_1', 'out_of_scope', undefined, ACTOR, NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the staff refusal note out of the audit diff', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'in_progress' }) });

    await harness.service.refuse(
      'dsr_1',
      'not_the_subject',
      'caller could not name the senior’s date of birth',
      ACTOR,
      NOW,
    );

    expect(JSON.stringify(harness.audits)).not.toContain('date of birth');
  });
});

describe('DataSubjectRequestsService.extend', () => {
  it('moves the deadline by the statutory extension and records the reason', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'in_progress' }) });

    const row = await harness.service.extend('dsr_1', 'awaiting a partner export', ACTOR, NOW);

    expect(row.dueAt.toISOString()).toBe('2026-10-24T12:00:00.000Z'); // +45 more days
    expect(row.extensionReason).toBe('awaiting a partner export');
    expect(row.extendedAt).not.toBeNull();
  });

  it('permits the extension exactly ONCE', async () => {
    const harness = makeHarness({
      existing: baseRow({ status: 'in_progress', extendedAt: NOW, extensionReason: 'first' }),
    });

    await expect(harness.service.extend('dsr_1', 'and again', ACTOR, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('cannot extend a closed request', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'refused' }) });

    await expect(harness.service.extend('dsr_1', 'why not', ACTOR, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('DataSubjectRequestsService.withdraw', () => {
  it('lets the requester withdraw their own request', async () => {
    const harness = makeHarness({ existing: baseRow({ status: 'in_progress' }) });

    const row = await harness.service.withdraw('dsr_1', 'usr_requester', ACTOR, NOW);

    expect(row.status).toBe('withdrawn');
    expect(row.withdrawnAt).not.toBeNull();
  });

  it('404s — not 403s — when the request belongs to somebody else', async () => {
    // On a privacy surface, confirming that a given request EXISTS is
    // itself a disclosure.
    const harness = makeHarness({ existing: baseRow({ requesterUserId: 'usr_other' }) });

    await expect(
      harness.service.withdraw('dsr_1', 'usr_requester', ACTOR, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DataSubjectRequestsService reads', () => {
  it('404s another user’s request on the requester read', async () => {
    const harness = makeHarness({ existing: baseRow({ requesterUserId: 'usr_other' }) });

    await expect(harness.service.getForRequester('dsr_1', 'usr_requester')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the caller’s own request', async () => {
    const harness = makeHarness({ existing: baseRow() });

    const row = await harness.service.getForRequester('dsr_1', 'usr_requester');

    expect(row.id).toBe('dsr_1');
  });
});
