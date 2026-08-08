import { randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import { MfaRecoveryCodeService } from './mfa-recovery-code.service';
import { MfaSecretCipherService } from './mfa-secret-cipher.service';
import { MfaService } from './mfa.service';
import type { RefreshTokenService } from './refresh-token.service';
import { TotpService } from './totp.service';

interface MfaMethodRow {
  id: string;
  userId: string;
  kind: 'totp' | 'sms_backup';
  secretCiphertext: Buffer;
  secretIv: Buffer;
  secretAuthTag: Buffer;
  keyVersion: number;
  label: string | null;
  lastUsedStep: bigint | null;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

interface UserRow {
  id: string;
  mfaEnabled: boolean;
}

interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  revokedAt: Date | null;
}

interface RecoveryCodeRow {
  id: string;
  userId: string;
  codeHash: string;
  consumedAt: Date | null;
}

/**
 * In-memory Prisma fake covering the surfaces MfaService touches:
 * `mfaMethod` (create / findFirst / findUnique / findMany / count /
 * update / updateMany) and `user` (update). $transaction passes the
 * fake itself as `tx` so the txn-block code paths are exercised.
 */
class FakePrisma {
  methods = new Map<string, MfaMethodRow>();
  users = new Map<string, UserRow>();
  refreshTokens = new Map<string, RefreshTokenRow>();
  recoveryCodes = new Map<string, RecoveryCodeRow>();
  private nextId = 1;
  private nextTokenId = 1;
  private nextRecoveryId = 1;

  mfaMethod = {
    create: async (args: {
      data: Omit<
        MfaMethodRow,
        'id' | 'createdAt' | 'deletedAt' | 'lastUsedStep' | 'confirmedAt' | 'lastUsedAt'
      > & {
        confirmedAt?: Date | null;
        lastUsedAt?: Date | null;
        lastUsedStep?: bigint | null;
      };
      select?: unknown;
    }): Promise<{ id: string }> => {
      const id = `mfa_${this.nextId++}`;
      this.methods.set(id, {
        id,
        userId: args.data.userId,
        kind: args.data.kind,
        secretCiphertext: args.data.secretCiphertext,
        secretIv: args.data.secretIv,
        secretAuthTag: args.data.secretAuthTag,
        keyVersion: args.data.keyVersion,
        label: args.data.label ?? null,
        lastUsedStep: args.data.lastUsedStep ?? null,
        confirmedAt: args.data.confirmedAt ?? null,
        lastUsedAt: args.data.lastUsedAt ?? null,
        createdAt: new Date(),
        deletedAt: null,
      });
      return { id };
    },
    findFirst: async (args: {
      where: { userId: string; confirmedAt?: { not: null }; deletedAt: null };
      select?: unknown;
    }): Promise<{ id: string } | null> => {
      for (const row of this.methods.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.deletedAt !== null) continue;
        if (args.where.confirmedAt && row.confirmedAt === null) continue;
        return { id: row.id };
      }
      return null;
    },
    findUnique: async (args: {
      where: { id: string };
      select?: unknown;
    }): Promise<MfaMethodRow | null> => {
      const row = this.methods.get(args.where.id);
      return row ? { ...row } : null;
    },
    findMany: async (args: {
      where: { userId: string; confirmedAt?: { not: null }; deletedAt: null };
      select?: unknown;
      orderBy?: unknown;
    }): Promise<MfaMethodRow[]> => {
      const out: MfaMethodRow[] = [];
      for (const row of this.methods.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.deletedAt !== null) continue;
        if (args.where.confirmedAt && row.confirmedAt === null) continue;
        out.push({ ...row });
      }
      return out;
    },
    count: async (args: {
      where: { userId: string; confirmedAt?: { not: null }; deletedAt: null };
    }): Promise<number> => {
      const list = await this.mfaMethod.findMany({ where: args.where });
      return list.length;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<MfaMethodRow>;
      select?: unknown;
    }): Promise<{ id: string }> => {
      const row = this.methods.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data);
      return { id: row.id };
    },
    updateMany: async (args: {
      where: {
        id: string;
        OR?: Array<{ lastUsedStep: null } | { lastUsedStep: { lt: bigint } }>;
      };
      data: Partial<MfaMethodRow>;
    }): Promise<{ count: number }> => {
      const row = this.methods.get(args.where.id);
      if (!row) return { count: 0 };
      if (args.where.OR) {
        const target = (args.data.lastUsedStep ?? null) as bigint | null;
        const ok = args.where.OR.some((clause) => {
          if ('lastUsedStep' in clause && clause.lastUsedStep === null) {
            return row.lastUsedStep === null;
          }
          if (
            'lastUsedStep' in clause &&
            typeof clause.lastUsedStep === 'object' &&
            'lt' in clause.lastUsedStep
          ) {
            return row.lastUsedStep !== null && row.lastUsedStep < clause.lastUsedStep.lt;
          }
          return false;
        });
        if (!ok) return { count: 0 };
        if (target !== null) row.lastUsedStep = target;
        if (args.data.lastUsedAt) row.lastUsedAt = args.data.lastUsedAt;
        return { count: 1 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };

  user = {
    update: async (args: {
      where: { id: string };
      data: Partial<UserRow>;
      select?: unknown;
    }): Promise<{ id: string }> => {
      const row = this.users.get(args.where.id);
      if (!row) throw new Error('user not found');
      Object.assign(row, args.data);
      return { id: row.id };
    },
  };

  refreshToken = {
    updateMany: async (args: {
      where: { userId: string; revokedAt: null };
      data: Partial<RefreshTokenRow>;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.refreshTokens.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.revokedAt !== null) continue;
        Object.assign(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  mfaRecoveryCode = {
    deleteMany: async (args: { where: { userId: string } }): Promise<{ count: number }> => {
      let count = 0;
      for (const [key, row] of this.recoveryCodes) {
        if (row.userId !== args.where.userId) continue;
        this.recoveryCodes.delete(key);
        count += 1;
      }
      return { count };
    },
    createMany: async (args: {
      data: Array<{ userId: string; codeHash: string }>;
    }): Promise<{ count: number }> => {
      for (const row of args.data) {
        const id = `rec_${this.nextRecoveryId++}`;
        this.recoveryCodes.set(id, {
          id,
          userId: row.userId,
          codeHash: row.codeHash,
          consumedAt: null,
        });
      }
      return { count: args.data.length };
    },
    updateMany: async (args: {
      where: { codeHash: string; userId: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.recoveryCodes.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.codeHash !== args.where.codeHash) continue;
        if (row.consumedAt !== null) continue;
        row.consumedAt = args.data.consumedAt;
        count += 1;
      }
      return { count };
    },
    count: async (args: { where: { userId: string; consumedAt: null } }): Promise<number> => {
      let count = 0;
      for (const row of this.recoveryCodes.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.consumedAt !== null) continue;
        count += 1;
      }
      return count;
    },
  };

  /** Seed an active refresh token for the test. */
  seedActiveRefreshToken(userId: string, familyId: string): void {
    const id = `refresh_${this.nextTokenId++}`;
    this.refreshTokens.set(id, { id, userId, familyId, revokedAt: null });
  }

  async $transaction<T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return cb(this);
  }
}

/**
 * Fake RefreshTokenService that exercises the production
 * `revokeAllFamiliesForUser` path against the FakePrisma. Using
 * the real class would pull TokenService + every Env field; the
 * thin wrapper here is the minimum needed to verify wiring
 * without re-running TokenService's coverage.
 */
function buildFakeRefreshTokenService(prisma: FakePrisma): RefreshTokenService {
  return {
    revokeAllFamiliesForUser: vi.fn(
      async (
        userId: string,
        options: { tx?: { refreshToken: FakePrisma['refreshToken'] } } = {},
      ) => {
        const client = options.tx ?? prisma;
        const result = await client.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return { revokedCount: result.count };
      },
    ),
  } as unknown as RefreshTokenService;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const base = {
    MFA_TOTP_ENC_KEY: randomBytes(32).toString('base64'),
    MFA_TOTP_ENC_KEY_VERSION: 1,
    MFA_TOTP_PERIOD_SECONDS: 30,
    MFA_TOTP_DIGITS: 6,
    MFA_TOTP_WINDOW: 1,
    MFA_TOTP_ISSUER: 'Taste & See',
  } as const;
  return { ...base, ...overrides } as unknown as Env;
}

describe('MfaService', () => {
  let prisma: FakePrisma;
  let env: Env;
  let totp: TotpService;
  let cipher: MfaSecretCipherService;
  let refreshTokens: RefreshTokenService;
  let recoveryCodes: MfaRecoveryCodeService;
  let svc: MfaService;

  beforeEach(() => {
    prisma = new FakePrisma();
    env = makeEnv();
    totp = new TotpService(env);
    cipher = new MfaSecretCipherService(env);
    refreshTokens = buildFakeRefreshTokenService(prisma);
    recoveryCodes = new MfaRecoveryCodeService(prisma as unknown as PrismaService);
    svc = new MfaService(
      prisma as unknown as PrismaService,
      cipher,
      totp,
      refreshTokens,
      recoveryCodes,
    );
    prisma.users.set('usr_1', { id: 'usr_1', mfaEnabled: false });
  });

  describe('beginEnrollment', () => {
    it('persists an unconfirmed method with encrypted secret + returns otpauth URL', async () => {
      const result = await svc.beginEnrollment({
        userId: 'usr_1',
        accountLabel: 'alice@example.com',
      });
      expect(result.methodId).toMatch(/^mfa_/);
      expect(result.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(result.otpauthUrl).toContain(`secret=${result.secretBase32}`);

      const row = prisma.methods.get(result.methodId)!;
      expect(row.kind).toBe('totp');
      expect(row.confirmedAt).toBeNull();
      expect(row.deletedAt).toBeNull();
      expect(row.keyVersion).toBe(1);
      // Encrypted secret round-trips through the cipher.
      const decrypted = cipher.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
        keyVersion: row.keyVersion,
      });
      expect(decrypted).toBe(result.secretBase32);
    });

    it('rejects when a confirmed method already exists', async () => {
      const first = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'alice@x' });
      const code = totp.generateCode(first.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: first.methodId, code });

      await expect(
        svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'alice@x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('confirmEnrollment', () => {
    it('happy path — flips confirmedAt and user.mfaEnabled', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });

      const row = prisma.methods.get(begun.methodId)!;
      expect(row.confirmedAt).toBeInstanceOf(Date);
      expect(row.lastUsedStep).not.toBeNull();
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(true);
    });

    it('rejects with 400 when the code is wrong', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      await expect(
        svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code: '000000' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Failed confirm leaves the row unconfirmed and mfaEnabled false.
      expect(prisma.methods.get(begun.methodId)!.confirmedAt).toBeNull();
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(false);
    });

    it('rejects with 404 when the method is not found OR belongs to another user', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      await expect(
        svc.confirmEnrollment({ userId: 'usr_other', methodId: begun.methodId, code: '000000' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.confirmEnrollment({ userId: 'usr_1', methodId: 'mfa_999', code: '000000' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects with 409 when the method is already confirmed', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });
      await expect(
        svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verifyForChallenge', () => {
    it('returns true on a valid code and updates lastUsedAt + lastUsedStep', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const enrollCode = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code: enrollCode });

      // Move forward a step so the verify is against a fresh code (not the
      // same one already consumed by enrollment).
      const nextStep = totp.currentStep() + 1;
      const fresh = totp.generateCode(begun.secretBase32, nextStep);
      // Backdate the last-used step so the fresh code is strictly newer.
      const row = prisma.methods.get(begun.methodId)!;
      row.lastUsedStep = BigInt(nextStep - 1);

      const ok = await svc.verifyForChallenge({ userId: 'usr_1', code: fresh });
      expect(ok).toBe(true);
      expect(row.lastUsedAt).toBeInstanceOf(Date);
      expect(row.lastUsedStep).toBe(BigInt(nextStep));
    });

    it('returns false on a wrong code', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const enrollCode = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code: enrollCode });

      const ok = await svc.verifyForChallenge({ userId: 'usr_1', code: '000000' });
      expect(ok).toBe(false);
    });

    it('returns false when the user has no confirmed methods', async () => {
      // User exists, no MFA registered.
      const ok = await svc.verifyForChallenge({ userId: 'usr_1', code: '123456' });
      expect(ok).toBe(false);
    });

    it('rejects replay of the same code (lastUsedStep guard)', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });

      // Re-presenting the same code should fail because confirmEnrollment
      // already advanced lastUsedStep to the same step.
      const replayed = await svc.verifyForChallenge({ userId: 'usr_1', code });
      expect(replayed).toBe(false);
    });
  });

  describe('listMethods', () => {
    it('returns confirmed and unconfirmed methods, omits soft-deleted', async () => {
      const a = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(a.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: a.methodId, code });

      // Mark the row soft-deleted: should disappear from the list.
      prisma.methods.get(a.methodId)!.deletedAt = new Date();

      const methods = await svc.listMethods('usr_1');
      expect(methods).toHaveLength(0);
    });
  });

  describe('removeMethod', () => {
    it('soft-deletes and clears mfaEnabled when the last confirmed method is removed', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(true);

      await svc.removeMethod({ userId: 'usr_1', methodId: begun.methodId });

      expect(prisma.methods.get(begun.methodId)!.deletedAt).toBeInstanceOf(Date);
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(false);
    });

    it('rejects with 404 when the method belongs to another user', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      await expect(
        svc.removeMethod({ userId: 'usr_other', methodId: begun.methodId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('session rotation on MFA change (TS-023-followup-5)', () => {
    /**
     * The invariant: any successful `confirmEnrollment` /
     * `removeMethod` must revoke every outstanding refresh-token
     * family for the affected user. Without this, an attacker who
     * has already established a session survives the user's MFA
     * change — a corner-case the platform's CLAUDE.md §3.1
     * "authentication-posture change → re-auth" spirit closes.
     */

    it('confirmEnrollment revokes every active refresh-token family for the user', async () => {
      // Seed two active sessions for the user — multiple devices,
      // multiple browser tabs, etc. Both must end up revoked.
      prisma.seedActiveRefreshToken('usr_1', 'fam_a');
      prisma.seedActiveRefreshToken('usr_1', 'fam_b');
      // And one for a DIFFERENT user — must be untouched.
      prisma.users.set('usr_2', { id: 'usr_2', mfaEnabled: false });
      prisma.seedActiveRefreshToken('usr_2', 'fam_c');

      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });

      const usr1Tokens = [...prisma.refreshTokens.values()].filter((t) => t.userId === 'usr_1');
      expect(usr1Tokens).toHaveLength(2);
      for (const t of usr1Tokens) {
        expect(t.revokedAt).toBeInstanceOf(Date);
      }

      // The other user's session must be intact — the revocation
      // is scoped to the user whose MFA changed.
      const usr2Token = [...prisma.refreshTokens.values()].find((t) => t.userId === 'usr_2');
      expect(usr2Token?.revokedAt).toBeNull();
    });

    it('confirmEnrollment is a 0-row no-op when the user has no sessions yet', async () => {
      // Freshly-signed-up user enrolling MFA before establishing a
      // session: nothing to revoke, but the call must succeed.
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      const result = await svc.confirmEnrollment({
        userId: 'usr_1',
        methodId: begun.methodId,
        code,
      });
      expect(result.recoveryCodes).toHaveLength(10);
      // MFA flag still flipped — the no-row revocation didn't
      // block the rest of the transaction.
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(true);
    });

    it('removeMethod revokes every active refresh-token family for the user', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });

      // Confirm flipped mfaEnabled AND revoked any prior sessions
      // (test #1 above proves the second half). Now seed FRESH
      // post-MFA sessions, then remove the method — those must
      // also be revoked.
      prisma.seedActiveRefreshToken('usr_1', 'fam_post_mfa_a');
      prisma.seedActiveRefreshToken('usr_1', 'fam_post_mfa_b');

      await svc.removeMethod({ userId: 'usr_1', methodId: begun.methodId });

      const postMfaTokens = [...prisma.refreshTokens.values()].filter(
        (t) => t.familyId === 'fam_post_mfa_a' || t.familyId === 'fam_post_mfa_b',
      );
      expect(postMfaTokens).toHaveLength(2);
      for (const t of postMfaTokens) {
        expect(t.revokedAt).toBeInstanceOf(Date);
      }
      // mfaEnabled flipped back to false too (last confirmed
      // method gone) — the revocation didn't block that leg.
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(false);
    });

    it('failed confirm (bad code) does NOT revoke sessions', async () => {
      prisma.seedActiveRefreshToken('usr_1', 'fam_a');
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });

      await expect(
        svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code: '000000' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The bad-code path throws BEFORE the transaction runs, so
      // no MFA state changed AND no session was revoked. This is
      // the right behaviour — a typo'd code shouldn't log the
      // user out of all their sessions.
      const token = [...prisma.refreshTokens.values()][0];
      expect(token?.revokedAt).toBeNull();
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(false);
    });

    it('failed remove (404 wrong user) does NOT revoke sessions', async () => {
      const begun = await svc.beginEnrollment({ userId: 'usr_1', accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      await svc.confirmEnrollment({ userId: 'usr_1', methodId: begun.methodId, code });

      // Seed sessions AFTER the enroll-confirm revocation so we
      // can assert the failed-remove leaves them alone.
      prisma.seedActiveRefreshToken('usr_1', 'fam_post');
      prisma.users.set('usr_other', { id: 'usr_other', mfaEnabled: false });
      prisma.seedActiveRefreshToken('usr_other', 'fam_other');

      await expect(
        svc.removeMethod({ userId: 'usr_other', methodId: begun.methodId }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const usr1Active = [...prisma.refreshTokens.values()].find((t) => t.familyId === 'fam_post');
      expect(usr1Active?.revokedAt).toBeNull();
      const otherActive = [...prisma.refreshTokens.values()].find(
        (t) => t.familyId === 'fam_other',
      );
      expect(otherActive?.revokedAt).toBeNull();
    });
  });

  describe('recovery codes (TS-023-followup-2)', () => {
    /** Confirm an MFA method and return the issued recovery codes. */
    async function enrolWithRecovery(userId = 'usr_1'): Promise<readonly string[]> {
      const begun = await svc.beginEnrollment({ userId, accountLabel: 'a@x' });
      const code = totp.generateCode(begun.secretBase32);
      const { recoveryCodes: codes } = await svc.confirmEnrollment({
        userId,
        methodId: begun.methodId,
        code,
      });
      return codes;
    }

    it('confirmEnrollment mints 10 display-form codes and stores only hashes', async () => {
      const codes = await enrolWithRecovery();
      expect(codes).toHaveLength(10);
      // Display form is grouped XXXXX-XXXXX over the Crockford alphabet.
      for (const c of codes) {
        expect(c).toMatch(/^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);
      }
      // Codes are unique within the batch.
      expect(new Set(codes).size).toBe(10);
      // Persisted rows hold a hash, never the plaintext.
      const rows = [...prisma.recoveryCodes.values()].filter((r) => r.userId === 'usr_1');
      expect(rows).toHaveLength(10);
      for (const r of rows) {
        expect(r.consumedAt).toBeNull();
        // The plaintext (with or without dash) never appears as the hash.
        for (const c of codes) {
          expect(r.codeHash).not.toBe(c);
          expect(r.codeHash).not.toBe(c.replace('-', ''));
        }
      }
    });

    it('re-enrolment deletes the prior batch (no stale codes linger)', async () => {
      const first = await enrolWithRecovery();
      // Remove the method (clears codes) then re-enrol.
      const methodId = [...prisma.methods.values()].find((m) => m.confirmedAt !== null)!.id;
      await svc.removeMethod({ userId: 'usr_1', methodId });
      expect([...prisma.recoveryCodes.values()]).toHaveLength(0);

      const second = await enrolWithRecovery();
      expect([...prisma.recoveryCodes.values()]).toHaveLength(10);
      // A code from the first batch no longer verifies.
      expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: first[0]! })).toBe(false);
      // A code from the fresh batch does.
      expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: second[0]! })).toBe(true);
    });

    describe('verifyRecoveryCode', () => {
      it('accepts a valid code, consumes it, and rejects replay', async () => {
        const codes = await enrolWithRecovery();
        const target = codes[3]!;

        expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: target })).toBe(true);
        // Consumed row is marked spent.
        const consumed = [...prisma.recoveryCodes.values()].filter((r) => r.consumedAt !== null);
        expect(consumed).toHaveLength(1);
        // Replay of the same code fails (single-use).
        expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: target })).toBe(false);
        // The other 9 remain usable.
        expect(await recoveryCodes.countRemaining('usr_1')).toBe(9);
      });

      it('accepts the code regardless of separators / case (normalisation)', async () => {
        const codes = await enrolWithRecovery();
        const target = codes[0]!;
        // Strip the dash and lowercase — must still match.
        const mangled = target.replace('-', '').toLowerCase();
        expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: mangled })).toBe(true);
      });

      it('rejects a malformed code without consuming anything', async () => {
        await enrolWithRecovery();
        expect(await svc.verifyRecoveryCode({ userId: 'usr_1', code: 'nope' })).toBe(false);
        expect(await recoveryCodes.countRemaining('usr_1')).toBe(10);
      });

      it("rejects another user's code (codeHash is global but scoped to the user)", async () => {
        const codes = await enrolWithRecovery('usr_1');
        prisma.users.set('usr_2', { id: 'usr_2', mfaEnabled: false });
        // usr_2 presents one of usr_1's codes — must fail.
        expect(await svc.verifyRecoveryCode({ userId: 'usr_2', code: codes[0]! })).toBe(false);
        // usr_1's code is therefore NOT consumed.
        expect(await recoveryCodes.countRemaining('usr_1')).toBe(10);
      });
    });

    it('removeMethod invalidates the whole batch when MFA is disabled', async () => {
      await enrolWithRecovery();
      expect([...prisma.recoveryCodes.values()]).toHaveLength(10);
      const methodId = [...prisma.methods.values()].find((m) => m.confirmedAt !== null)!.id;

      await svc.removeMethod({ userId: 'usr_1', methodId });

      expect([...prisma.recoveryCodes.values()].filter((r) => r.userId === 'usr_1')).toHaveLength(
        0,
      );
      expect(prisma.users.get('usr_1')!.mfaEnabled).toBe(false);
    });
  });
});
