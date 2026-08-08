import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { LockoutService, computeLockedUntil } from './lockout.service';

const NOW = new Date('2026-05-10T12:00:00.000Z');
const ONE_MIN = 60_000;
const ONE_HOUR = 60 * ONE_MIN;
const ONE_DAY = 24 * ONE_HOUR;

describe('computeLockedUntil — pure schedule', () => {
  it.each([
    [0, null],
    [1, null],
    [2, null],
  ])('returns null for grace-threshold count %d', (count, expected) => {
    expect(computeLockedUntil(count, NOW)).toBe(expected);
  });

  // The formula is `60s * 2^(count - 3)` clamped at 24h. Counts 3-13
  // follow the raw doubling; count 14+ hits the cap. These expectations
  // mirror the formula literally — not rounded to "nice" human-friendly
  // hours — so the test is a guard against drift between the comment
  // and the implementation.
  it.each([
    [3, ONE_MIN],
    [4, 2 * ONE_MIN],
    [5, 4 * ONE_MIN],
    [6, 8 * ONE_MIN],
    [7, 16 * ONE_MIN],
    [8, 32 * ONE_MIN],
    [9, 64 * ONE_MIN],
    [10, 128 * ONE_MIN],
    [11, 256 * ONE_MIN],
    [12, 512 * ONE_MIN],
    [13, 1024 * ONE_MIN],
  ])('count %d → 60s * 2^(count-3)', (count, deltaMs) => {
    const got = computeLockedUntil(count, NOW);
    if (got === null) throw new Error('expected a non-null lock');
    expect(got.getTime() - NOW.getTime()).toBe(deltaMs);
  });

  it('caps at 24h once the doubled window would exceed the ceiling', () => {
    // count=14 → raw 2048m (~34h), capped to 24h.
    const fourteen = computeLockedUntil(14, NOW);
    if (fourteen === null) throw new Error('expected a non-null lock');
    expect(fourteen.getTime() - NOW.getTime()).toBe(ONE_DAY);

    // count=100 → enormous raw window, still capped.
    const hundred = computeLockedUntil(100, NOW);
    if (hundred === null) throw new Error('expected a non-null lock');
    expect(hundred.getTime() - NOW.getTime()).toBe(ONE_DAY);
  });

  it('never produces a non-finite lock for absurdly large counts', () => {
    const got = computeLockedUntil(10_000, NOW);
    if (got === null) throw new Error('expected a non-null lock');
    expect(Number.isFinite(got.getTime())).toBe(true);
    expect(got.getTime() - NOW.getTime()).toBe(ONE_DAY);
  });

  it('anchors the lock to the supplied `now` instant', () => {
    const other = new Date('2026-12-31T23:59:00.000Z');
    const got = computeLockedUntil(3, other);
    if (got === null) throw new Error('expected a non-null lock');
    expect(got.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

/**
 * Hand-rolled fake user table. Mirrors only the columns the service
 * touches: id, failed_login_count, last_failed_login_at, locked_until.
 *
 * The `$transaction` fake runs the callback against the same `tx`
 * object that holds the `user` model — there is no isolation /
 * rollback semantics, which is fine for a single-test scope.
 */
interface FakeUserRow {
  id: string;
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
}

interface UserUpdateArgs {
  where: { id: string };
  data: {
    failedLoginCount?: { increment: number } | number;
    lastFailedLoginAt?: Date | null;
    lockedUntil?: Date | null;
  };
  select?: Partial<Record<keyof FakeUserRow, true>>;
}

function buildFakePrisma(initial: FakeUserRow): {
  prisma: PrismaService;
  rows: Map<string, FakeUserRow>;
  updateCalls: UserUpdateArgs[];
} {
  const rows = new Map<string, FakeUserRow>([[initial.id, { ...initial }]]);
  const updateCalls: UserUpdateArgs[] = [];
  const update = vi.fn(async (args: UserUpdateArgs) => {
    updateCalls.push(args);
    const existing = rows.get(args.where.id);
    if (existing === undefined) {
      const err = new Error(`Record not found: ${args.where.id}`) as Error & {
        code: string;
      };
      err.code = 'P2025';
      throw err;
    }
    const next: FakeUserRow = { ...existing };
    if (args.data.failedLoginCount !== undefined) {
      const delta = args.data.failedLoginCount;
      next.failedLoginCount =
        typeof delta === 'number' ? delta : existing.failedLoginCount + delta.increment;
    }
    if (Object.prototype.hasOwnProperty.call(args.data, 'lastFailedLoginAt')) {
      next.lastFailedLoginAt = args.data.lastFailedLoginAt ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(args.data, 'lockedUntil')) {
      next.lockedUntil = args.data.lockedUntil ?? null;
    }
    rows.set(args.where.id, next);
    // Project the requested select shape so the service's
    // structural narrowing stays honest.
    const select = args.select ?? { id: true };
    const out: Partial<FakeUserRow> = {};
    for (const key of Object.keys(select) as (keyof FakeUserRow)[]) {
      if (select[key] === true) {
        (out as Record<string, unknown>)[key] = next[key];
      }
    }
    return out;
  });
  const $transaction = vi.fn(
    async (cb: (tx: { user: { update: typeof update } }) => Promise<unknown>) => {
      return cb({ user: { update } });
    },
  );
  const prisma = {
    user: { update },
    $transaction,
  } as unknown as PrismaService;
  return { prisma, rows, updateCalls };
}

describe('LockoutService.isLocked', () => {
  it('returns false when lockedUntil is null', () => {
    const svc = new LockoutService({} as unknown as PrismaService);
    expect(svc.isLocked(null, NOW)).toBe(false);
  });

  it('returns true when lockedUntil is strictly in the future', () => {
    const svc = new LockoutService({} as unknown as PrismaService);
    const future = new Date(NOW.getTime() + ONE_MIN);
    expect(svc.isLocked(future, NOW)).toBe(true);
  });

  it('returns false at the exact deadline (lock has elapsed)', () => {
    const svc = new LockoutService({} as unknown as PrismaService);
    expect(svc.isLocked(NOW, NOW)).toBe(false);
  });

  it('returns false when lockedUntil is in the past', () => {
    const svc = new LockoutService({} as unknown as PrismaService);
    const past = new Date(NOW.getTime() - ONE_MIN);
    expect(svc.isLocked(past, NOW)).toBe(false);
  });

  it('defaults `now` to wall-clock time when omitted', () => {
    const svc = new LockoutService({} as unknown as PrismaService);
    const future = new Date(Date.now() + ONE_HOUR);
    expect(svc.isLocked(future)).toBe(true);
  });
});

describe('LockoutService.recordFailure', () => {
  it('increments failedLoginCount and stamps lastFailedLoginAt', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(1);
    expect(result.lockedUntil).toBeNull();
    const after = rows.get('u_1');
    expect(after?.failedLoginCount).toBe(1);
    expect(after?.lastFailedLoginAt?.toISOString()).toBe(NOW.toISOString());
    expect(after?.lockedUntil).toBeNull();
  });

  it('does not set lockedUntil on the first two failures (grace window)', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 1,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(2);
    expect(result.lockedUntil).toBeNull();
    expect(rows.get('u_1')?.lockedUntil).toBeNull();
  });

  it('sets lockedUntil on the third failure (first lock at the 1-minute step)', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 2,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(3);
    expect(result.lockedUntil?.getTime()).toBe(NOW.getTime() + ONE_MIN);
    expect(rows.get('u_1')?.lockedUntil?.getTime()).toBe(NOW.getTime() + ONE_MIN);
  });

  it('extends an existing lock when the new computed window is later', async () => {
    // Existing lock at NOW+30s (left over from a prior schedule). The
    // 4th failure should compute a 2m lock starting from NOW — strictly
    // later than NOW+30s, so the lock extends.
    const earlier = new Date(NOW.getTime() + 30_000);
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 3,
      lastFailedLoginAt: null,
      lockedUntil: earlier,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(4);
    expect(result.lockedUntil?.getTime()).toBe(NOW.getTime() + 2 * ONE_MIN);
    expect(rows.get('u_1')?.lockedUntil?.getTime()).toBe(NOW.getTime() + 2 * ONE_MIN);
  });

  it('does not shrink an existing lock when the new computed window is earlier', async () => {
    // Existing lock at NOW+1h (a previous attempt locked aggressively).
    // The current attempt computes a 1m lock (3rd failure semantics)
    // which is earlier than the existing 1h lock — anti-shrinkage rule
    // means the persisted value stays at 1h.
    const aggressiveExisting = new Date(NOW.getTime() + ONE_HOUR);
    const { prisma, rows, updateCalls } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 2,
      lastFailedLoginAt: null,
      lockedUntil: aggressiveExisting,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(3);
    // Returned lock is the existing (larger) value, not the candidate.
    expect(result.lockedUntil?.getTime()).toBe(aggressiveExisting.getTime());
    expect(rows.get('u_1')?.lockedUntil?.getTime()).toBe(aggressiveExisting.getTime());
    // Only the increment update fires; no redundant second write to
    // the already-correct lockedUntil.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.data?.lockedUntil).toBeUndefined();
  });

  it('caps the lock at 24h even at very high failure counts', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 99,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_1', NOW);

    expect(result.failedLoginCount).toBe(100);
    expect(result.lockedUntil?.getTime()).toBe(NOW.getTime() + ONE_DAY);
    expect(rows.get('u_1')?.lockedUntil?.getTime()).toBe(NOW.getTime() + ONE_DAY);
  });

  it('returns a benign result when the user row is missing (P2025)', async () => {
    const { prisma } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    const result = await svc.recordFailure('u_nonexistent', NOW);

    expect(result).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe('LockoutService.recordSuccess', () => {
  it('clears counter, lastFailedLoginAt, and lockedUntil', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 7,
      lastFailedLoginAt: new Date('2026-05-10T11:55:00.000Z'),
      lockedUntil: new Date('2026-05-10T11:59:00.000Z'),
    });
    const svc = new LockoutService(prisma);

    await svc.recordSuccess('u_1');

    const after = rows.get('u_1');
    expect(after?.failedLoginCount).toBe(0);
    expect(after?.lastFailedLoginAt).toBeNull();
    expect(after?.lockedUntil).toBeNull();
  });

  it('is a no-op on a clean account (no prior failures)', async () => {
    const { prisma, rows } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    await svc.recordSuccess('u_1');

    const after = rows.get('u_1');
    expect(after?.failedLoginCount).toBe(0);
    expect(after?.lastFailedLoginAt).toBeNull();
    expect(after?.lockedUntil).toBeNull();
  });

  it('swallows P2025 when the user row is missing (deletion race)', async () => {
    const { prisma } = buildFakePrisma({
      id: 'u_1',
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    });
    const svc = new LockoutService(prisma);

    await expect(svc.recordSuccess('u_nonexistent')).resolves.toBeUndefined();
  });
});
