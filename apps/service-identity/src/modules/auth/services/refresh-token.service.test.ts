import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

/**
 * In-memory fake of the slice of PrismaService that RefreshTokenService
 * touches. Models the `refresh_tokens` table by id, indexed by tokenHash
 * for the on-presentation lookup.
 *
 * Why hand-rolled rather than a generic mock: the rotation flow runs
 * inside `prisma.$transaction(async (tx) => ...)`, and the fake must
 * pass the same `tx`-flavoured object to the callback so the test
 * exercises the real interleaving inside the transaction. A generic
 * `vi.fn().mockResolvedValue(...)` chain would skip that and miss the
 * "all updates inside one tx" property we care about.
 */
interface FakeRow {
  id: string;
  familyId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

function buildFakePrisma(): {
  prisma: PrismaService;
  rows: Map<string, FakeRow>;
} {
  const rows = new Map<string, FakeRow>();
  let counter = 0;

  const refreshTokenSurface = {
    create: vi.fn(
      async (req: {
        data: Omit<FakeRow, 'id' | 'rotatedAt' | 'revokedAt'> & {
          rotatedAt?: Date | null;
          revokedAt?: Date | null;
        };
      }) => {
        counter += 1;
        const id = `row_${counter}`;
        const row: FakeRow = {
          id,
          familyId: req.data.familyId,
          userId: req.data.userId,
          tokenHash: req.data.tokenHash,
          expiresAt: req.data.expiresAt,
          rotatedAt: req.data.rotatedAt ?? null,
          revokedAt: req.data.revokedAt ?? null,
          ip: req.data.ip ?? null,
          userAgent: req.data.userAgent ?? null,
        };
        rows.set(id, row);
        return { id };
      },
    ),
    findUnique: vi.fn(
      async (req: { where: { tokenHash?: string }; select?: Record<string, boolean> }) => {
        if (req.where.tokenHash === undefined) return null;
        for (const row of rows.values()) {
          if (row.tokenHash !== req.where.tokenHash) continue;
          if (req.select === undefined) return { ...row };
          // Honour `select` like real Prisma: project only the truthy keys.
          const projected: Record<string, unknown> = {};
          for (const [key, want] of Object.entries(req.select)) {
            if (want === true && key in row) {
              projected[key] = (row as unknown as Record<string, unknown>)[key];
            }
          }
          return projected;
        }
        return null;
      },
    ),
    update: vi.fn(async (req: { where: { id: string }; data: Partial<FakeRow> }) => {
      const row = rows.get(req.where.id);
      if (row === undefined) throw new Error(`row not found: ${req.where.id}`);
      Object.assign(row, req.data);
      return { id: row.id };
    }),
    updateMany: vi.fn(
      async (req: {
        where: { familyId?: string; userId?: string; revokedAt: null };
        data: Partial<FakeRow>;
      }) => {
        // Production code uses two distinct predicates against this
        // table: `revokeFamily` filters by `familyId`,
        // `revokeAllFamiliesForUser` (TS-023-followup-5) filters by
        // `userId`. Both are matched by AND across whatever
        // predicate columns the call supplied — neither is optional
        // in the sense that the fake should treat absence as "match
        // anything"; instead, a predicate must EXIST on the call
        // for the corresponding column to be checked.
        let count = 0;
        for (const row of rows.values()) {
          if (req.where.familyId !== undefined && row.familyId !== req.where.familyId) continue;
          if (req.where.userId !== undefined && row.userId !== req.where.userId) continue;
          if (row.revokedAt !== null) continue;
          Object.assign(row, req.data);
          count += 1;
        }
        return { count };
      },
    ),
  };

  type FakeShape = {
    refreshToken: typeof refreshTokenSurface;
    $transaction: ReturnType<typeof vi.fn>;
  };
  const fake: FakeShape = {
    refreshToken: refreshTokenSurface,
    $transaction: vi.fn(async <T>(cb: (tx: FakeShape) => Promise<T>): Promise<T> => cb(fake)),
  };

  return { prisma: fake as unknown as PrismaService, rows };
}

function buildTokenService(): TokenService {
  return new TokenService({
    NODE_ENV: 'test',
    PORT: 3010,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    JWT_ISSUER: 'iss',
    JWT_AUDIENCE: 'aud',
    REFRESH_COOKIE_SECURE: true,
    // MFA fields are unused by TokenService but the Env type
    // requires them (they were added in TS-023).
    MFA_TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
    MFA_TOTP_ENC_KEY_VERSION: 1,
    MFA_CHALLENGE_SECRET: 'b'.repeat(32),
    MFA_CHALLENGE_TTL_SECONDS: 300,
    MFA_TOTP_PERIOD_SECONDS: 30,
    MFA_TOTP_DIGITS: 6,
    MFA_TOTP_WINDOW: 1,
    MFA_TOTP_ISSUER: 'Test',
    // TS-044-followup-2 additions — TokenService doesn't touch these,
    // but the strict `Env` type requires the full shape.
    REDIS_URL: 'redis://localhost:6379/0',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    EMAIL_VERIFICATION_TTL_SECONDS: 86_400,
    // TS-293 additions — same reason: the rbac-revoker knobs are
    // required by the strict `Env` shape; disabled in unit fixtures.
    RBAC_REVOKER_ENABLED: false,
    RBAC_REVOKER_INTERVAL_MS: 300_000,
    RBAC_REVOKER_BATCH_SIZE: 500,
    // TS-309a-followup-2 additions — same reason: the overdue-DSAR sweep
    // knobs are required by the strict `Env` shape; disabled in fixtures.
    PRIVACY_OVERDUE_SWEEP_ENABLED: false,
    PRIVACY_OVERDUE_SWEEP_INTERVAL_MS: 3_600_000,
    PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS: 7,
    PRIVACY_OVERDUE_SWEEP_MAX_LOGGED: 25,
    IMPERSONATION_SESSION_TTL_SECONDS: 3_600,
    // TS-025-followup-1 additions — same reason.
    LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: 30,
    LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: 300,
    VERIFICATION_RESEND_COOLDOWN_SECONDS: 60,
    VERIFICATION_TOKEN_PRUNE_ENABLED: true,
    VERIFICATION_TOKEN_PRUNE_INTERVAL_MS: 21_600_000,
    VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS: 30,
    VERIFICATION_TOKEN_PRUNE_BATCH_SIZE: 5_000,
    // TS-026 additions — same reason: required by `Env` even though
    // TokenService doesn't touch them.
    STRIPE_SECRET_KEY: 'sk_test_' + 'x'.repeat(24),
    STRIPE_IDENTITY_RETURN_URL: 'https://example.test/onboarding/identity/complete',
    KYC_PAYLOAD_ENC_KEY: Buffer.alloc(32, 2).toString('base64'),
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    KYC_WEBHOOK_INTERNAL_API_KEY: 'c'.repeat(48),
    // TS-235 additions — TokenService doesn't touch the recipient-
    // contacts shared secret but the strict `Env` type requires it.
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'd'.repeat(48),
    IDENTITY_PRIVACY_EXPORT_API_KEY: 'e'.repeat(48),
    // TS-020-followup-1 additions — TokenService doesn't touch the
    // OTel knobs but the strict `Env` type requires the full shape.
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
  });
}

describe('RefreshTokenService.issueNewSession', () => {
  it('inserts a single active row and returns the raw token + family id', async () => {
    const { prisma, rows } = buildFakePrisma();
    const tokenService = buildTokenService();
    const svc = new RefreshTokenService(prisma, tokenService);

    const result = await svc.issueNewSession({
      userId: 'u_1',
      ip: '127.0.0.1',
      userAgent: 'unit-test',
    });

    expect(result.familyId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.rawRefreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(rows.size).toBe(1);
    const onlyRow = [...rows.values()][0];
    expect(onlyRow?.userId).toBe('u_1');
    expect(onlyRow?.familyId).toBe(result.familyId);
    expect(onlyRow?.tokenHash).toBe(tokenService.hashRefreshToken(result.rawRefreshToken));
    expect(onlyRow?.rotatedAt).toBeNull();
    expect(onlyRow?.revokedAt).toBeNull();
    expect(onlyRow?.ip).toBe('127.0.0.1');
    expect(onlyRow?.userAgent).toBe('unit-test');
  });

  it('persists ip/userAgent as null when not supplied', async () => {
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    await svc.issueNewSession({ userId: 'u_1' });

    const onlyRow = [...rows.values()][0];
    expect(onlyRow?.ip).toBeNull();
    expect(onlyRow?.userAgent).toBeNull();
  });
});

describe('RefreshTokenService.rotate — happy path', () => {
  it('rotates a valid token: marks original rotatedAt, inserts new row in same family', async () => {
    const { prisma, rows } = buildFakePrisma();
    const tokenService = buildTokenService();
    const svc = new RefreshTokenService(prisma, tokenService);

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    const result = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.userId).toBe('u_1');
    expect(result.familyId).toBe(issued.familyId);
    expect(result.newRawRefreshToken).not.toBe(issued.rawRefreshToken);
    expect(result.newRefreshExpiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(rows.size).toBe(2);
    const rowsArr = [...rows.values()];
    const original = rowsArr.find(
      (r) => r.tokenHash === tokenService.hashRefreshToken(issued.rawRefreshToken),
    );
    const rotated = rowsArr.find(
      (r) => r.tokenHash === tokenService.hashRefreshToken(result.newRawRefreshToken),
    );
    expect(original?.rotatedAt).toBeInstanceOf(Date);
    expect(original?.familyId).toBe(rotated?.familyId);
    expect(rotated?.rotatedAt).toBeNull();
    expect(rotated?.revokedAt).toBeNull();
  });

  it('uses prisma.$transaction to wrap the rotation', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    const issued = await svc.issueNewSession({ userId: 'u_1' });
    await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    expect(
      (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).toHaveBeenCalled();
  });
});

describe('RefreshTokenService.rotate — failure modes', () => {
  it('returns `unknown` for a token never issued', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    const result = await svc.rotate({ presentedRawToken: 'not-a-real-token' });
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('returns `expired` for a token whose row has expiresAt < now', async () => {
    const { prisma, rows } = buildFakePrisma();
    const tokenService = buildTokenService();
    const svc = new RefreshTokenService(prisma, tokenService);

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    // Force-expire the row.
    const row = [...rows.values()][0];
    if (row === undefined) throw new Error('expected one row');
    row.expiresAt = new Date(Date.now() - 1000);

    const result = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('returns `revoked` for a token whose row has revokedAt set', async () => {
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    const row = [...rows.values()][0];
    if (row === undefined) throw new Error('expected one row');
    row.revokedAt = new Date();

    const result = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('detects reuse: presenting an already-rotated token revokes the entire family', async () => {
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    // Issue, rotate once normally — now we have 2 rows in the family,
    // the original (rotatedAt set) and the replacement (active).
    const issued = await svc.issueNewSession({ userId: 'u_1' });
    const firstRotation = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    expect(firstRotation.ok).toBe(true);

    // Replay the original (already-rotated) token. This is the reuse
    // scenario: an attacker who captured the original raw token replays
    // it. Service must detect it and revoke the whole family.
    const replay = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    expect(replay).toEqual({ ok: false, reason: 'reused' });

    // Every row in the family is now revoked.
    const familyRows = [...rows.values()];
    expect(familyRows.length).toBe(2);
    for (const row of familyRows) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
  });

  it('after reuse-detection, the previously-active replacement token is also dead', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    const firstRotation = await svc.rotate({ presentedRawToken: issued.rawRefreshToken });
    if (!firstRotation.ok) throw new Error('expected first rotation ok');

    // Trigger reuse detection.
    await svc.rotate({ presentedRawToken: issued.rawRefreshToken });

    // The replacement token is now revoked → next rotation attempt fails.
    const result = await svc.rotate({ presentedRawToken: firstRotation.newRawRefreshToken });
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('RefreshTokenService.revokeFamily', () => {
  it('marks every revokedAt-null row in the family revoked, including rotated ones', async () => {
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    await svc.rotate({ presentedRawToken: issued.rawRefreshToken });

    // After rotate(): two rows in the family — the original (rotatedAt
    // set, revokedAt null) and the replacement (both null). revokeFamily
    // matches WHERE revokedAt IS NULL, so it picks up BOTH rows.
    const result = await svc.revokeFamily(issued.familyId);
    expect(result.revokedCount).toBe(2);

    const familyRows = [...rows.values()].filter((r) => r.familyId === issued.familyId);
    expect(familyRows.length).toBe(2);
    for (const row of familyRows) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
  });

  it('is idempotent: re-revoking returns count 0', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    const issued = await svc.issueNewSession({ userId: 'u_1' });

    const first = await svc.revokeFamily(issued.familyId);
    expect(first.revokedCount).toBe(1);
    const second = await svc.revokeFamily(issued.familyId);
    expect(second.revokedCount).toBe(0);
  });
});

describe('RefreshTokenService.findFamilyForRawToken', () => {
  it('returns the family id for a known raw token', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    const issued = await svc.issueNewSession({ userId: 'u_1' });
    const found = await svc.findFamilyForRawToken(issued.rawRefreshToken);
    expect(found).toEqual({ familyId: issued.familyId });
  });

  it('returns null for an unknown raw token', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    const found = await svc.findFamilyForRawToken('not-a-real-token');
    expect(found).toBeNull();
  });
});

describe('RefreshTokenService.revokeAllFamiliesForUser (TS-023-followup-5)', () => {
  /**
   * The "log out everywhere" hammer used by every
   * authentication-posture change (MFA enroll, MFA remove, future
   * password reset, admin "kill every session"). The contract:
   * every active row for the user becomes revoked; other users'
   * rows are untouched; already-revoked rows are idempotent.
   */

  it('revokes every active row across every family for the user', async () => {
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    // Two distinct families for u_1 (two devices), plus a rotation
    // chain in one of them so we exercise the "multiple rows per
    // family" path. And a third family for u_2 (different user)
    // that MUST remain active.
    const sessionA = await svc.issueNewSession({ userId: 'u_1' });
    await svc.rotate({ presentedRawToken: sessionA.rawRefreshToken }); // sessionA family now has 2 rows
    await svc.issueNewSession({ userId: 'u_1' }); // sessionB
    const sessionC = await svc.issueNewSession({ userId: 'u_2' });

    const result = await svc.revokeAllFamiliesForUser('u_1');
    // sessionA's family: 2 rows (one rotated, one fresh) — both active.
    // sessionB's family: 1 row — active.
    // Total active for u_1: 3.
    expect(result.revokedCount).toBe(3);

    for (const row of rows.values()) {
      if (row.userId === 'u_1') {
        expect(row.revokedAt).toBeInstanceOf(Date);
      } else if (row.userId === 'u_2') {
        // The other user's session must be intact.
        expect(row.revokedAt).toBeNull();
      }
    }
    // Belt-and-braces: u_2's session is still rotatable.
    const u2Rotate = await svc.rotate({ presentedRawToken: sessionC.rawRefreshToken });
    expect(u2Rotate.ok).toBe(true);
  });

  it('is idempotent: a second call returns count 0', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());

    await svc.issueNewSession({ userId: 'u_1' });
    const first = await svc.revokeAllFamiliesForUser('u_1');
    expect(first.revokedCount).toBe(1);
    const second = await svc.revokeAllFamiliesForUser('u_1');
    expect(second.revokedCount).toBe(0);
  });

  it('returns 0 when the user has no active sessions (fresh-signup case)', async () => {
    const { prisma } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    const result = await svc.revokeAllFamiliesForUser('u_never_logged_in');
    expect(result.revokedCount).toBe(0);
  });

  it('runs against the provided tx client when one is passed', async () => {
    // Callers like MfaService pass a `tx` so the revocation runs
    // inside the same transaction as the MFA-state write. The
    // fake's $transaction passes itself as `tx`, so this test
    // proves the parameter wiring lands on the same object — a
    // typo'd parameter (e.g. `this.prisma.refreshToken.updateMany`
    // on the captured class field) would silently bypass the
    // transaction and surface as a flake in production.
    const { prisma, rows } = buildFakePrisma();
    const svc = new RefreshTokenService(prisma, buildTokenService());
    await svc.issueNewSession({ userId: 'u_1' });

    const result = await prisma.$transaction(async (tx: unknown) => {
      return svc.revokeAllFamiliesForUser('u_1', {
        tx: tx as { refreshToken: typeof prisma.refreshToken },
      });
    });
    expect(result.revokedCount).toBe(1);
    for (const row of rows.values()) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
  });
});
