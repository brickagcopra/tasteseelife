import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import { MfaChallengeTokenService } from './mfa-challenge-token.service';

interface MfaChallengeRow {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * In-memory `mfa_challenges` substitute. Implements only the surface
 * the service uses: `create`, `findUnique`, `updateMany`, plus
 * `$transaction(cb => cb(self))` so the consume flow exercises the
 * same code path the real driver would — including the conditional-
 * update race protection.
 */
class FakePrisma {
  rows = new Map<string, MfaChallengeRow>();
  private nextId = 1;

  mfaChallenge = {
    create: async (args: {
      data: { userId: string; expiresAt: Date; ip: string | null; userAgent: string | null };
      select?: unknown;
    }): Promise<{ id: string }> => {
      const id = `chal_${this.nextId++}`;
      this.rows.set(id, {
        id,
        userId: args.data.userId,
        expiresAt: args.data.expiresAt,
        consumedAt: null,
        createdAt: new Date(),
        ip: args.data.ip,
        userAgent: args.data.userAgent,
      });
      return { id };
    },
    findUnique: async (args: {
      where: { id: string };
      select?: unknown;
    }): Promise<MfaChallengeRow | null> => {
      const row = this.rows.get(args.where.id);
      return row ? { ...row } : null;
    },
    updateMany: async (args: {
      where: { id: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }> => {
      const row = this.rows.get(args.where.id);
      if (!row) return { count: 0 };
      if (row.consumedAt !== null) return { count: 0 };
      row.consumedAt = args.data.consumedAt;
      return { count: 1 };
    },
  };

  async $transaction<T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return cb(this);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    MFA_CHALLENGE_SECRET: randomBytes(32).toString('base64'),
    MFA_CHALLENGE_TTL_SECONDS: 300,
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

function makeService(env: Env, prisma: FakePrisma): MfaChallengeTokenService {
  return new MfaChallengeTokenService(env, prisma as unknown as PrismaService);
}

describe('MfaChallengeTokenService', () => {
  let prisma: FakePrisma;
  let env: Env;
  let svc: MfaChallengeTokenService;

  beforeEach(() => {
    prisma = new FakePrisma();
    env = makeEnv();
    svc = makeService(env, prisma);
  });

  it('issue() inserts a tracking row and returns a signed JWT', async () => {
    const issued = await svc.issue({ userId: 'usr_1', ip: '1.2.3.4', userAgent: 'tests' });
    expect(issued.token.split('.')).toHaveLength(3);
    expect(issued.expiresInSeconds).toBe(300);
    expect(prisma.rows.size).toBe(1);
    const row = prisma.rows.get(issued.jti);
    expect(row).toBeDefined();
    expect(row!.userId).toBe('usr_1');
    expect(row!.consumedAt).toBeNull();
    expect(row!.ip).toBe('1.2.3.4');
    expect(row!.userAgent).toBe('tests');
  });

  it('consume() succeeds and marks the row consumed', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    const result = await svc.consume(issued.token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe('usr_42');
    expect(prisma.rows.get(issued.jti)!.consumedAt).toBeInstanceOf(Date);
  });

  it('consume() returns replayed on second use of the same token', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    const first = await svc.consume(issued.token);
    const second = await svc.consume(issued.token);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('replayed');
  });

  it('consume() returns expired when the row has past its expiry', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    // Backdate the row so expiresAt is in the past, but the JWT
    // signature is still valid (would be the case for a token
    // received within its TTL but processed after a clock skew).
    const row = prisma.rows.get(issued.jti)!;
    row.expiresAt = new Date(Date.now() - 1000);
    const result = await svc.consume(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('consume() returns expired when the JWT signature exp claim has passed', async () => {
    // Issue a service with a 1-second TTL, wait 1.1s, consume.
    const shortSvc = makeService(makeEnv({ MFA_CHALLENGE_TTL_SECONDS: 1 } as Partial<Env>), prisma);
    const issued = await shortSvc.issue({ userId: 'usr_42' });
    await new Promise((r) => setTimeout(r, 1100));
    const result = await shortSvc.consume(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('consume() returns invalid-signature on a token signed under a different secret', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    const otherSvc = makeService(makeEnv(), new FakePrisma());
    const result = await otherSvc.consume(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-signature');
  });

  it('consume() returns invalid-signature on a malformed token', async () => {
    const result = await svc.consume('this.is.not-a-jwt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-signature');
  });

  it('consume() returns unknown when the jti is not in the DB (issued by a different process)', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    // Drop the row to simulate "signed under our key but DB doesn't
    // know about it" — would happen only if the challenge secret
    // leaked.
    prisma.rows.delete(issued.jti);
    const result = await svc.consume(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('consume() returns unknown when the signed sub does not match the row userId', async () => {
    const issued = await svc.issue({ userId: 'usr_42' });
    const row = prisma.rows.get(issued.jti)!;
    row.userId = 'usr_imposter';
    const result = await svc.consume(issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});
