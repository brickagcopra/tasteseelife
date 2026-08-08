import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { MfaRecoveryCodeService } from './mfa-recovery-code.service';

interface RecoveryCodeRow {
  id: string;
  userId: string;
  codeHash: string;
  consumedAt: Date | null;
}

/**
 * In-memory Prisma fake covering the `mfaRecoveryCode` delegate
 * surfaces the service touches: deleteMany / createMany / updateMany /
 * count.
 */
class FakePrisma {
  rows = new Map<string, RecoveryCodeRow>();
  private nextId = 1;

  mfaRecoveryCode = {
    deleteMany: async (args: { where: { userId: string } }): Promise<{ count: number }> => {
      let count = 0;
      for (const [key, row] of this.rows) {
        if (row.userId !== args.where.userId) continue;
        this.rows.delete(key);
        count += 1;
      }
      return { count };
    },
    createMany: async (args: {
      data: Array<{ userId: string; codeHash: string }>;
    }): Promise<{ count: number }> => {
      for (const row of args.data) {
        const id = `rec_${this.nextId++}`;
        this.rows.set(id, { id, userId: row.userId, codeHash: row.codeHash, consumedAt: null });
      }
      return { count: args.data.length };
    },
    updateMany: async (args: {
      where: { codeHash: string; userId: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.rows.values()) {
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
      for (const row of this.rows.values()) {
        if (row.userId !== args.where.userId) continue;
        if (row.consumedAt !== null) continue;
        count += 1;
      }
      return count;
    },
  };
}

const sha256b64url = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('base64url');

describe('MfaRecoveryCodeService', () => {
  let prisma: FakePrisma;
  let svc: MfaRecoveryCodeService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = new MfaRecoveryCodeService(prisma as unknown as PrismaService);
  });

  describe('generate', () => {
    it('returns CODE_COUNT unique display codes and persists their hashes', async () => {
      const codes = await svc.generate({ userId: 'usr_1' });
      expect(codes).toHaveLength(MfaRecoveryCodeService.CODE_COUNT);
      expect(new Set(codes).size).toBe(MfaRecoveryCodeService.CODE_COUNT);
      for (const c of codes) {
        expect(c).toMatch(/^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);
      }
      // Stored hash equals SHA-256 of the normalised (de-dashed) form.
      const rows = [...prisma.rows.values()];
      expect(rows).toHaveLength(MfaRecoveryCodeService.CODE_COUNT);
      const storedHashes = new Set(rows.map((r) => r.codeHash));
      for (const c of codes) {
        expect(storedHashes.has(sha256b64url(c.replace('-', '')))).toBe(true);
      }
    });

    it('deletes any prior batch before inserting the new one', async () => {
      const first = await svc.generate({ userId: 'usr_1' });
      const second = await svc.generate({ userId: 'usr_1' });
      expect([...prisma.rows.values()]).toHaveLength(MfaRecoveryCodeService.CODE_COUNT);
      // A first-batch code no longer verifies.
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: first[0]! })).toBe(false);
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: second[0]! })).toBe(true);
    });

    it('scopes generation to the user (other users untouched)', async () => {
      await svc.generate({ userId: 'usr_1' });
      await svc.generate({ userId: 'usr_2' });
      expect(await svc.countRemaining('usr_1')).toBe(MfaRecoveryCodeService.CODE_COUNT);
      expect(await svc.countRemaining('usr_2')).toBe(MfaRecoveryCodeService.CODE_COUNT);
    });
  });

  describe('verifyAndConsume', () => {
    it('accepts a valid code once, then rejects replay', async () => {
      const codes = await svc.generate({ userId: 'usr_1' });
      const target = codes[2]!;
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: target })).toBe(true);
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: target })).toBe(false);
      expect(await svc.countRemaining('usr_1')).toBe(MfaRecoveryCodeService.CODE_COUNT - 1);
    });

    it('normalises separators, spaces, and case before matching', async () => {
      const codes = await svc.generate({ userId: 'usr_1' });
      const target = codes[0]!; // XXXXX-XXXXX
      const noDash = target.replace('-', '');
      const lower = target.toLowerCase();
      const spaced = `  ${noDash.slice(0, 5)} ${noDash.slice(5)}  `;
      // The first form consumes; the others should then miss (single-use),
      // proving they normalise to the SAME hash as the consumed code.
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: lower })).toBe(true);
      expect(await svc.verifyAndConsume({ userId: 'usr_1', code: spaced })).toBe(false);
    });

    it.each(['', 'short', 'has spaces only', '0123456789ABCDEF'])(
      'rejects malformed input %p without a DB write',
      async (bad) => {
        await svc.generate({ userId: 'usr_1' });
        expect(await svc.verifyAndConsume({ userId: 'usr_1', code: bad })).toBe(false);
        expect(await svc.countRemaining('usr_1')).toBe(MfaRecoveryCodeService.CODE_COUNT);
      },
    );

    it('does not accept a code minted for another user', async () => {
      const codes = await svc.generate({ userId: 'usr_1' });
      expect(await svc.verifyAndConsume({ userId: 'usr_2', code: codes[0]! })).toBe(false);
      expect(await svc.countRemaining('usr_1')).toBe(MfaRecoveryCodeService.CODE_COUNT);
    });
  });

  describe('invalidateAll', () => {
    it('deletes every code for the user and returns the count', async () => {
      await svc.generate({ userId: 'usr_1' });
      await svc.generate({ userId: 'usr_2' });
      const removed = await svc.invalidateAll({ userId: 'usr_1' });
      expect(removed).toBe(MfaRecoveryCodeService.CODE_COUNT);
      expect(await svc.countRemaining('usr_1')).toBe(0);
      // The other user is untouched.
      expect(await svc.countRemaining('usr_2')).toBe(MfaRecoveryCodeService.CODE_COUNT);
    });
  });
});
