import { describe, expect, it } from 'vitest';

import {
  AddThreadParticipantRequestSchema,
  AddThreadParticipantResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  ListThreadsInboxQuerySchema,
  RemoveThreadParticipantResponseSchema,
  THREAD_CREATE_PARTICIPANTS_MAX,
  THREAD_INBOX_LIMIT_DEFAULT,
  THREAD_INBOX_LIMIT_MAX,
  ThreadDetailResponseSchema,
  ThreadInboxEntrySchema,
  ThreadParticipantRecordSchema,
  ThreadRecordSchema,
  ThreadWithParticipantsRecordSchema,
  ThreadsInboxResponseSchema,
} from '../http/messaging-thread.schema';

const T0 = '2026-06-13T09:00:00.000Z';

function buildParticipant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thr_abc',
    userId: 'user_a',
    role: 'member',
    joinedAt: T0,
    lastReadMessageId: null,
    ...overrides,
  };
}

function buildThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thr_abc',
    kind: 'household',
    householdId: 'hh_abc',
    bookingId: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    ...overrides,
  };
}

describe('ThreadParticipantRecordSchema', () => {
  it('parses a member participant with no read cursor', () => {
    const parsed = ThreadParticipantRecordSchema.parse(buildParticipant());
    expect(parsed.role).toBe('member');
    expect(parsed.lastReadMessageId).toBeNull();
  });

  it('accepts a read cursor', () => {
    const parsed = ThreadParticipantRecordSchema.parse(
      buildParticipant({ lastReadMessageId: 'msg_123', role: 'observer' }),
    );
    expect(parsed.lastReadMessageId).toBe('msg_123');
    expect(parsed.role).toBe('observer');
  });

  it('rejects an unknown role', () => {
    expect(() =>
      ThreadParticipantRecordSchema.parse(buildParticipant({ role: 'admin' })),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => ThreadParticipantRecordSchema.parse(buildParticipant({ extra: 1 }))).toThrow();
  });
});

describe('ThreadRecordSchema', () => {
  it('parses a household thread', () => {
    const parsed = ThreadRecordSchema.parse(buildThread());
    expect(parsed.kind).toBe('household');
    expect(parsed.bookingId).toBeNull();
  });

  it('parses a booking thread with a bookingId', () => {
    const parsed = ThreadRecordSchema.parse(
      buildThread({ kind: 'booking', bookingId: 'bk_1', householdId: 'hh_abc' }),
    );
    expect(parsed.kind).toBe('booking');
    expect(parsed.bookingId).toBe('bk_1');
  });

  it('parses a peer_thread with both ids null', () => {
    const parsed = ThreadRecordSchema.parse(
      buildThread({ kind: 'peer_thread', householdId: null, bookingId: null }),
    );
    expect(parsed.householdId).toBeNull();
    expect(parsed.bookingId).toBeNull();
  });

  it('parses an archived thread', () => {
    const parsed = ThreadRecordSchema.parse(buildThread({ archivedAt: T0 }));
    expect(parsed.archivedAt).toBe(T0);
  });

  it('rejects an unknown kind', () => {
    expect(() => ThreadRecordSchema.parse(buildThread({ kind: 'dm' }))).toThrow();
  });
});

describe('ThreadWithParticipantsRecordSchema', () => {
  it('parses a thread with a participant list', () => {
    const parsed = ThreadWithParticipantsRecordSchema.parse(
      buildThread({ participants: [buildParticipant(), buildParticipant({ userId: 'user_b' })] }),
    );
    expect(parsed.participants).toHaveLength(2);
  });

  it('accepts an empty participant list', () => {
    const parsed = ThreadWithParticipantsRecordSchema.parse(buildThread({ participants: [] }));
    expect(parsed.participants).toEqual([]);
  });
});

describe('ThreadInboxEntrySchema', () => {
  it('parses an inbox entry with the caller facets', () => {
    const parsed = ThreadInboxEntrySchema.parse(
      buildThread({ myRole: 'observer', myLastReadMessageId: 'msg_9', participantCount: 3 }),
    );
    expect(parsed.myRole).toBe('observer');
    expect(parsed.myLastReadMessageId).toBe('msg_9');
    expect(parsed.participantCount).toBe(3);
  });

  it('rejects a negative participant count', () => {
    expect(() =>
      ThreadInboxEntrySchema.parse(
        buildThread({ myRole: 'member', myLastReadMessageId: null, participantCount: -1 }),
      ),
    ).toThrow();
  });
});

describe('CreateThreadRequestSchema', () => {
  it('parses a household thread with seeded participants + defaults participants', () => {
    const parsed = CreateThreadRequestSchema.parse({
      kind: 'household',
      householdId: 'hh_abc',
      participants: [{ userId: 'user_b', role: 'observer' }],
    });
    expect(parsed.participants).toHaveLength(1);
  });

  it('defaults participants to an empty array', () => {
    const parsed = CreateThreadRequestSchema.parse({ kind: 'household', householdId: 'hh_abc' });
    expect(parsed.participants).toEqual([]);
  });

  it('requires bookingId on a booking thread', () => {
    expect(() =>
      CreateThreadRequestSchema.parse({ kind: 'booking', householdId: 'hh_abc' }),
    ).toThrow();
  });

  it('accepts a booking thread with a bookingId (and optional household hint)', () => {
    const parsed = CreateThreadRequestSchema.parse({
      kind: 'booking',
      bookingId: 'bk_1',
      householdId: 'hh_abc',
    });
    expect(parsed.bookingId).toBe('bk_1');
  });

  it('requires householdId on a household thread', () => {
    expect(() => CreateThreadRequestSchema.parse({ kind: 'household' })).toThrow();
  });

  it('requires householdId on a concierge thread', () => {
    expect(() => CreateThreadRequestSchema.parse({ kind: 'concierge' })).toThrow();
  });

  it('forbids bookingId on a household thread', () => {
    expect(() =>
      CreateThreadRequestSchema.parse({
        kind: 'household',
        householdId: 'hh_abc',
        bookingId: 'bk_1',
      }),
    ).toThrow();
  });

  it('forbids both ids on a peer_thread', () => {
    expect(() =>
      CreateThreadRequestSchema.parse({ kind: 'peer_thread', householdId: 'hh_abc' }),
    ).toThrow();
    expect(() =>
      CreateThreadRequestSchema.parse({ kind: 'peer_thread', bookingId: 'bk_1' }),
    ).toThrow();
  });

  it('parses a bare peer_thread', () => {
    const parsed = CreateThreadRequestSchema.parse({ kind: 'peer_thread' });
    expect(parsed.kind).toBe('peer_thread');
  });

  it('rejects duplicate participant userIds', () => {
    expect(() =>
      CreateThreadRequestSchema.parse({
        kind: 'household',
        householdId: 'hh_abc',
        participants: [
          { userId: 'user_b', role: 'observer' },
          { userId: 'user_b', role: 'member' },
        ],
      }),
    ).toThrow();
  });

  it('rejects more than the participant cap', () => {
    const participants = Array.from({ length: THREAD_CREATE_PARTICIPANTS_MAX + 1 }, (_v, i) => ({
      userId: `user_${i}`,
      role: 'member' as const,
    }));
    expect(() =>
      CreateThreadRequestSchema.parse({ kind: 'household', householdId: 'hh_abc', participants }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      CreateThreadRequestSchema.parse({ kind: 'household', householdId: 'hh_abc', extra: true }),
    ).toThrow();
  });
});

describe('CreateThreadResponseSchema / ThreadDetailResponseSchema', () => {
  it('wraps a thread-with-participants record', () => {
    const thread = buildThread({ participants: [buildParticipant()] });
    expect(CreateThreadResponseSchema.parse({ thread }).thread.participants).toHaveLength(1);
    expect(ThreadDetailResponseSchema.parse({ thread }).thread.id).toBe('thr_abc');
  });
});

describe('ListThreadsInboxQuerySchema', () => {
  it('applies the default limit', () => {
    const parsed = ListThreadsInboxQuerySchema.parse({});
    expect(parsed.limit).toBe(THREAD_INBOX_LIMIT_DEFAULT);
    expect(parsed.includeArchived).toBeUndefined();
  });

  it('coerces limit from a string and caps it', () => {
    expect(ListThreadsInboxQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(() =>
      ListThreadsInboxQuerySchema.parse({ limit: String(THREAD_INBOX_LIMIT_MAX + 1) }),
    ).toThrow();
  });

  it('transforms includeArchived to a boolean', () => {
    expect(ListThreadsInboxQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(
      true,
    );
    expect(ListThreadsInboxQuerySchema.parse({ includeArchived: 'false' }).includeArchived).toBe(
      false,
    );
  });

  it('rejects a non-enum includeArchived', () => {
    expect(() => ListThreadsInboxQuerySchema.parse({ includeArchived: 'yes' })).toThrow();
  });
});

describe('ThreadsInboxResponseSchema', () => {
  it('wraps a list of inbox entries', () => {
    const entry = buildThread({ myRole: 'member', myLastReadMessageId: null, participantCount: 1 });
    expect(ThreadsInboxResponseSchema.parse({ threads: [entry] }).threads).toHaveLength(1);
  });
});

describe('AddThreadParticipantRequestSchema', () => {
  it('parses a { userId, role } body', () => {
    const parsed = AddThreadParticipantRequestSchema.parse({ userId: 'user_c', role: 'observer' });
    expect(parsed.userId).toBe('user_c');
    expect(parsed.role).toBe('observer');
  });

  it('rejects a missing role', () => {
    expect(() => AddThreadParticipantRequestSchema.parse({ userId: 'user_c' })).toThrow();
  });
});

describe('AddThreadParticipantResponseSchema', () => {
  it('parses an added outcome with the participant', () => {
    const parsed = AddThreadParticipantResponseSchema.parse({
      participant: buildParticipant({ userId: 'user_c' }),
      outcome: 'added',
    });
    expect(parsed.outcome).toBe('added');
  });

  it('parses an already_present outcome', () => {
    const parsed = AddThreadParticipantResponseSchema.parse({
      participant: buildParticipant(),
      outcome: 'already_present',
    });
    expect(parsed.outcome).toBe('already_present');
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      AddThreadParticipantResponseSchema.parse({
        participant: buildParticipant(),
        outcome: 'merged',
      }),
    ).toThrow();
  });
});

describe('RemoveThreadParticipantResponseSchema', () => {
  it('parses a removed outcome', () => {
    const parsed = RemoveThreadParticipantResponseSchema.parse({
      outcome: 'removed',
      threadId: 'thr_abc',
      userId: 'user_c',
    });
    expect(parsed.outcome).toBe('removed');
  });

  it('parses a not_present outcome', () => {
    const parsed = RemoveThreadParticipantResponseSchema.parse({
      outcome: 'not_present',
      threadId: 'thr_abc',
      userId: 'user_c',
    });
    expect(parsed.outcome).toBe('not_present');
  });
});
