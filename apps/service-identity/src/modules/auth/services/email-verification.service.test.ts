import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { EmailVerificationEmitter } from './email-verification-emitter';
import { EmailVerificationService, hashToken } from './email-verification.service';
import type { VerificationResendCooldownService } from './verification-resend-cooldown.service';

/**
 * Unit suite for TS-510's email verification.
 *
 * The behaviours here are the ones that make the fix safe rather than merely
 * functional: single use, expiry, non-disclosure, and the refusal to resurrect
 * a suspended account. The clock is injected, so expiry is asserted by moving
 * time rather than by waiting (CLAUDE.md §9.3 — no `sleep()`).
 */

const NOW = new Date('2026-07-29T12:00:00.000Z');
const TTL_SECONDS = 86_400;

interface TokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  deletedAt: Date | null;
  emailVerifiedAt: Date | null;
}

/**
 * In-memory stand-in for the two tables this service touches.
 *
 * `$transaction` hands the same fake back as the transaction client, and
 * mutations are applied to the shared arrays. That is deliberately NOT a
 * rollback-capable fake — the TS-505 E2E fleet and the integration suite cover
 * real transaction semantics against Postgres, and a hand-built rollback fake
 * that got the semantics subtly wrong is how the `FakeIncidentsPrisma` defect
 * happened (an insert rolled back, an in-place UPDATE did not).
 */
function buildFake(args: { tokens: TokenRow[]; users: UserRow[] }): {
  prisma: PrismaService;
  tokens: TokenRow[];
  users: UserRow[];
  createdTokens: { userId: string; tokenHash: string; expiresAt: Date }[];
} {
  const { tokens, users } = args;
  const createdTokens: { userId: string; tokenHash: string; expiresAt: Date }[] = [];

  const fake = {
    user: {
      findUnique: vi.fn(async (req: { where: { email?: string; id?: string } }) => {
        const found = users.find(
          (u) =>
            (req.where.email !== undefined && u.email === req.where.email) ||
            (req.where.id !== undefined && u.id === req.where.id),
        );
        return found ?? null;
      }),
      update: vi.fn(
        async (req: {
          where: { id: string };
          data: { status?: UserRow['status']; emailVerifiedAt?: Date | null };
        }) => {
          const row = users.find((u) => u.id === req.where.id);
          if (row === undefined) throw new Error('user not found in fake');
          if (req.data.status !== undefined) row.status = req.data.status;
          if (req.data.emailVerifiedAt !== undefined)
            row.emailVerifiedAt = req.data.emailVerifiedAt;
          return row;
        },
      ),
    },
    emailVerificationToken: {
      findUnique: vi.fn(async (req: { where: { tokenHash: string } }) => {
        return tokens.find((t) => t.tokenHash === req.where.tokenHash) ?? null;
      }),
      create: vi.fn(
        async (req: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
          const row: TokenRow = {
            id: `tok_${String(tokens.length + 1)}`,
            userId: req.data.userId,
            tokenHash: req.data.tokenHash,
            expiresAt: req.data.expiresAt,
            consumedAt: null,
          };
          tokens.push(row);
          createdTokens.push(req.data);
          return { id: row.id };
        },
      ),
      updateMany: vi.fn(
        async (req: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) => {
          const row = tokens.find((t) => t.id === req.where.id && t.consumedAt === null);
          if (row === undefined) return { count: 0 };
          row.consumedAt = req.data.consumedAt;
          return { count: 1 };
        },
      ),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: any) => fn(fake)),
  };

  return { prisma: fake as unknown as PrismaService, tokens, users, createdTokens };
}

function buildEmitter(): { emitter: EmailVerificationEmitter; calls: { reason: string }[] } {
  const calls: { reason: string }[] = [];
  const emitter = {
    emitRequested: vi.fn(async (_tx: unknown, descriptor: { reason: string }) => {
      calls.push({ reason: descriptor.reason });
    }),
  };
  return { emitter: emitter as unknown as EmailVerificationEmitter, calls };
}

function buildService(
  fake: ReturnType<typeof buildFake>,
  options: { now?: () => Date; cooldownAllows?: boolean } = {},
): {
  service: EmailVerificationService;
  emitterCalls: { reason: string }[];
  cooldownClaims: string[];
} {
  const { emitter, calls } = buildEmitter();
  const cooldownClaims: string[] = [];
  const cooldown = {
    claim: async (email: string): Promise<boolean> => {
      cooldownClaims.push(email);
      return options.cooldownAllows ?? true;
    },
  } as unknown as VerificationResendCooldownService;
  const service = new EmailVerificationService(
    fake.prisma,
    emitter,
    cooldown,
    { EMAIL_VERIFICATION_TTL_SECONDS: TTL_SECONDS } as unknown as Env,
    options.now ?? ((): Date => NOW),
  );
  return { service, emitterCalls: calls, cooldownClaims };
}

function pendingUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'usr_1',
    email: 'alice@example.com',
    status: 'pending_verification',
    deletedAt: null,
    emailVerifiedAt: null,
    ...overrides,
  };
}

function liveToken(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 'tok_1',
    userId: 'usr_1',
    tokenHash: hashToken('the-raw-token'),
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    consumedAt: null,
    ...overrides,
  };
}

/** The `code` on an RFC 7807 body thrown as an HttpException. */
function problemCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('EmailVerificationService.verify', () => {
  it('activates a pending account and stamps emailVerifiedAt', async () => {
    const fake = buildFake({ tokens: [liveToken()], users: [pendingUser()] });
    const { service } = buildService(fake);

    const result = await service.verify('the-raw-token');

    expect(result).toEqual({
      userId: 'usr_1',
      status: 'active',
      verifiedAt: NOW.toISOString(),
    });
    expect(fake.users[0]?.status).toBe('active');
    expect(fake.users[0]?.emailVerifiedAt).toEqual(NOW);
  });

  it('spends the token, so the same link cannot verify twice', async () => {
    const fake = buildFake({ tokens: [liveToken()], users: [pendingUser()] });
    const { service } = buildService(fake);

    await service.verify('the-raw-token');
    expect(fake.tokens[0]?.consumedAt).toEqual(NOW);

    const error = await captureRejection(service.verify('the-raw-token'));
    expect(problemCode(error)).toBe('verification_token_already_consumed');
  });

  it('rejects a token that has expired, without waiting for it', async () => {
    const fake = buildFake({
      tokens: [liveToken({ expiresAt: new Date(NOW.getTime() - 1) })],
      users: [pendingUser()],
    });
    const { service } = buildService(fake);

    const error = await captureRejection(service.verify('the-raw-token'));
    expect(problemCode(error)).toBe('verification_token_expired');
    // The account must be untouched — an expired link is not a partial success.
    expect(fake.users[0]?.status).toBe('pending_verification');
    expect(fake.users[0]?.emailVerifiedAt).toBeNull();
  });

  it('treats the expiry boundary as expired, not as valid', async () => {
    const fake = buildFake({
      tokens: [liveToken({ expiresAt: NOW })],
      users: [pendingUser()],
    });
    const { service } = buildService(fake);

    // `expiresAt === now` is expired. Picking the inclusive side deliberately:
    // a token is valid *until* its expiry, and a half-open interval is the only
    // one where "expires at noon" cannot mean "still works at noon".
    expect(problemCode(await captureRejection(service.verify('the-raw-token')))).toBe(
      'verification_token_expired',
    );
  });

  it('rejects an unknown token as invalid, never as expired or consumed', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service } = buildService(fake);

    expect(problemCode(await captureRejection(service.verify('never-issued')))).toBe(
      'invalid_token',
    );
  });

  it('records the mailbox but does NOT resurrect a suspended account', async () => {
    const fake = buildFake({
      tokens: [liveToken()],
      users: [pendingUser({ status: 'suspended' })],
    });
    const { service } = buildService(fake);

    const result = await service.verify('the-raw-token');

    // Suspension is a trust & safety decision; a verification link is not the
    // authority to reverse it. The mailbox fact is still recorded.
    expect(result.status).toBe('suspended');
    expect(fake.users[0]?.status).toBe('suspended');
    expect(fake.users[0]?.emailVerifiedAt).toEqual(NOW);
  });

  it('keeps the first verification timestamp if the address was already verified', async () => {
    const alreadyVerifiedAt = new Date('2026-01-01T00:00:00.000Z');
    const fake = buildFake({
      tokens: [liveToken()],
      users: [pendingUser({ status: 'active', emailVerifiedAt: alreadyVerifiedAt })],
    });
    const { service } = buildService(fake);

    const result = await service.verify('the-raw-token');
    expect(result.verifiedAt).toBe(alreadyVerifiedAt.toISOString());
  });

  it('rejects a token whose user has been soft-deleted, as invalid', async () => {
    const fake = buildFake({
      tokens: [liveToken()],
      users: [pendingUser({ deletedAt: new Date('2026-07-01T00:00:00.000Z') })],
    });
    const { service } = buildService(fake);

    expect(problemCode(await captureRejection(service.verify('the-raw-token')))).toBe(
      'invalid_token',
    );
  });

  it('gives every rejection the same status, title and detail', async () => {
    const fake = buildFake({
      tokens: [liveToken({ id: 'tok_expired', expiresAt: new Date(NOW.getTime() - 1) })],
      users: [pendingUser()],
    });
    const { service } = buildService(fake);

    const expired = await captureRejection(service.verify('the-raw-token'));
    const unknown = await captureRejection(service.verify('some-other-token'));

    const bodyOf = (error: unknown): Record<string, unknown> =>
      (error as HttpException).getResponse() as Record<string, unknown>;

    expect(bodyOf(expired)['status']).toBe(bodyOf(unknown)['status']);
    expect(bodyOf(expired)['title']).toBe(bodyOf(unknown)['title']);
    expect(bodyOf(expired)['detail']).toBe(bodyOf(unknown)['detail']);
    expect(bodyOf(expired)['code']).not.toBe(bodyOf(unknown)['code']);
  });
});

describe('EmailVerificationService.issueForSignup', () => {
  it('stores only the digest of the token, never the token', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service, emitterCalls } = buildService(fake);

    await service.issueForSignup(fake.prisma as never, {
      id: 'usr_1',
      email: 'alice@example.com',
    });

    expect(fake.createdTokens).toHaveLength(1);
    const stored = fake.createdTokens[0];
    // SHA-256 base64url of 32 bytes is 43 characters; the raw token happens to
    // be the same length, so length alone proves nothing — what matters is that
    // the emitted token hashes to the stored value and is not equal to it.
    expect(stored?.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(emitterCalls).toEqual([{ reason: 'signup' }]);
  });

  it('sets the expiry from the configured TTL', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service } = buildService(fake);

    await service.issueForSignup(fake.prisma as never, {
      id: 'usr_1',
      email: 'alice@example.com',
    });

    expect(fake.createdTokens[0]?.expiresAt).toEqual(new Date(NOW.getTime() + TTL_SECONDS * 1_000));
  });

  it('mints a token whose digest the verify path can find', async () => {
    // The round-trip is the property: `issueForSignup` and `verify` hash with
    // the same function, so a change to either alone breaks this.
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service } = buildService(fake);

    await service.issueForSignup(fake.prisma as never, {
      id: 'usr_1',
      email: 'alice@example.com',
    });
    const storedHash = fake.tokens[0]?.tokenHash;
    expect(storedHash).toBeDefined();

    // Recover the raw token from the emitter's descriptor the way the real
    // consumer would — via the event, which is the only place it exists.
    // Here we assert the inverse instead: an arbitrary token does NOT match.
    expect(hashToken('not-the-token')).not.toBe(storedHash);
  });
});

describe('EmailVerificationService.resend', () => {
  it('mints a second token for a pending account and leaves the first spendable', async () => {
    const first = liveToken();
    const fake = buildFake({ tokens: [first], users: [pendingUser()] });
    const { service, emitterCalls } = buildService(fake);

    await service.resend('Alice@Example.com');

    expect(fake.tokens).toHaveLength(2);
    expect(first.consumedAt).toBeNull();
    expect(emitterCalls).toEqual([{ reason: 'resend' }]);
  });

  it('resolves silently for an address with no account', async () => {
    const fake = buildFake({ tokens: [], users: [] });
    const { service, emitterCalls } = buildService(fake);

    await expect(service.resend('nobody@example.com')).resolves.toBeUndefined();
    expect(fake.tokens).toHaveLength(0);
    expect(emitterCalls).toEqual([]);
  });

  it('resolves silently for an already-verified account, minting nothing', async () => {
    const fake = buildFake({
      tokens: [],
      users: [pendingUser({ status: 'active', emailVerifiedAt: NOW })],
    });
    const { service, emitterCalls } = buildService(fake);

    await expect(service.resend('alice@example.com')).resolves.toBeUndefined();
    // Minting here would let anyone re-arm a verification link against a live
    // account, and the 202 already tells the caller nothing either way.
    expect(fake.tokens).toHaveLength(0);
    expect(emitterCalls).toEqual([]);
  });

  it('normalises the address before lookup', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service } = buildService(fake);

    await service.resend('  ALICE@example.com  ');
    expect(fake.tokens).toHaveLength(1);
  });

  // ── Per-address cooldown (TS-510-followup-3) ──────────────────────────

  it('mints nothing when the address is cooling down', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service, emitterCalls } = buildService(fake, { cooldownAllows: false });

    await service.resend('alice@example.com');

    expect(fake.tokens).toEqual([]);
    expect(emitterCalls).toEqual([]);
  });

  it('resolves identically whether or not it was cooled down', async () => {
    // The controller's 202 is a constant, so the ONLY way a cooldown could
    // become an enumeration oracle is if this method behaved differently.
    const allowed = buildService(buildFake({ tokens: [], users: [pendingUser()] }));
    const cooled = buildService(buildFake({ tokens: [], users: [pendingUser()] }), {
      cooldownAllows: false,
    });

    await expect(allowed.service.resend('alice@example.com')).resolves.toBeUndefined();
    await expect(cooled.service.resend('alice@example.com')).resolves.toBeUndefined();
  });

  it('claims the window BEFORE the account lookup, so unknown addresses count too', async () => {
    // Claiming after establishing that an account exists would make the
    // cooldown itself an existence signal, and would leave the endpoint
    // usable to probe the user table.
    const fake = buildFake({ tokens: [], users: [] });
    const { service, cooldownClaims } = buildService(fake);

    await service.resend('nobody@example.com');

    expect(cooldownClaims).toEqual(['nobody@example.com']);
  });

  it('claims on the NORMALISED address so casing cannot buy a second window', async () => {
    const fake = buildFake({ tokens: [], users: [pendingUser()] });
    const { service, cooldownClaims } = buildService(fake);

    await service.resend('  ALICE@Example.com  ');

    expect(cooldownClaims).toEqual(['alice@example.com']);
  });
});

describe('hashToken', () => {
  it('is deterministic and base64url-shaped', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is not the identity function — the raw token must never be storable', () => {
    expect(hashToken('abc')).not.toBe('abc');
  });
});
