import { describe, expect, it } from 'vitest';

import {
  THREAD_KINDS,
  THREAD_PARTICIPANT_ROLES,
  canModerateThread,
  canPostInThread,
  type ThreadKind,
  type ThreadParticipantRole,
} from './thread-posting-policy';

describe('thread-posting-policy const unions', () => {
  it('enumerates the four thread kinds (mirrors messaging.thread_kind)', () => {
    expect([...THREAD_KINDS]).toEqual(['household', 'booking', 'concierge', 'peer_thread']);
  });

  it('enumerates the four participant roles (mirrors messaging.thread_participant_role)', () => {
    expect([...THREAD_PARTICIPANT_ROLES]).toEqual(['member', 'observer', 'concierge', 'moderator']);
  });
});

describe('canPostInThread', () => {
  // The full grid, asserted exhaustively so a future matrix edit that
  // silently flips a cell fails loudly.
  const expectations: ReadonlyArray<[ThreadKind, ThreadParticipantRole, boolean]> = [
    // household — TS-070 semantics unchanged
    ['household', 'member', true],
    ['household', 'observer', false],
    ['household', 'concierge', true],
    ['household', 'moderator', false],
    // booking — TS-070 semantics unchanged
    ['booking', 'member', true],
    ['booking', 'observer', false],
    ['booking', 'concierge', true],
    ['booking', 'moderator', false],
    // concierge — TS-070 semantics unchanged
    ['concierge', 'member', true],
    ['concierge', 'observer', false],
    ['concierge', 'concierge', true],
    ['concierge', 'moderator', false],
    // peer_thread — TS-209: providers + moderators post, observers
    // read-only, concierge has no standing in a provider-only space
    ['peer_thread', 'member', true],
    ['peer_thread', 'observer', false],
    ['peer_thread', 'concierge', false],
    ['peer_thread', 'moderator', true],
  ];

  it.each(expectations)('(%s, %s) → %s', (kind, role, allowed) => {
    expect(canPostInThread(kind, role)).toBe(allowed);
  });

  it('covers every (kind, role) pair exactly once', () => {
    expect(expectations).toHaveLength(THREAD_KINDS.length * THREAD_PARTICIPANT_ROLES.length);
    const seen = new Set(expectations.map(([k, r]) => `${k}:${r}`));
    expect(seen.size).toBe(expectations.length);
  });

  it('grants observers no posting standing on any thread kind', () => {
    for (const kind of THREAD_KINDS) {
      expect(canPostInThread(kind, 'observer')).toBe(false);
    }
  });
});

describe('canModerateThread', () => {
  it('grants moderation only to a moderator on a peer_thread', () => {
    expect(canModerateThread('peer_thread', 'moderator')).toBe(true);
  });

  it('denies moderation to non-moderator roles on a peer_thread', () => {
    for (const role of THREAD_PARTICIPANT_ROLES) {
      if (role === 'moderator') continue;
      expect(canModerateThread('peer_thread', role)).toBe(false);
    }
  });

  it('denies moderation on every non-peer thread kind, even for a moderator', () => {
    for (const kind of THREAD_KINDS) {
      if (kind === 'peer_thread') continue;
      for (const role of THREAD_PARTICIPANT_ROLES) {
        expect(canModerateThread(kind, role)).toBe(false);
      }
    }
  });
});
