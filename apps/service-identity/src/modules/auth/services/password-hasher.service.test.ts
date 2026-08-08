import { describe, expect, it } from 'vitest';

import { BCRYPT_COST_FACTOR, PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  const hasher = new PasswordHasherService();

  describe('cost factor', () => {
    it(`is configured at ${BCRYPT_COST_FACTOR} (CLAUDE.md §3.1: cost ≥ 12)`, () => {
      expect(BCRYPT_COST_FACTOR).toBeGreaterThanOrEqual(12);
    });

    it('embeds the configured cost in produced digests', async () => {
      const digest = await hasher.hash('correct horse battery staple');
      expect(digest).toMatch(new RegExp(`^\\$2[abxy]\\$${BCRYPT_COST_FACTOR}\\$`));
    }, 30_000);
  });

  describe('hash + verify round-trip', () => {
    it('verify() returns true for the originating plaintext', async () => {
      const digest = await hasher.hash('correct horse battery staple');
      expect(await hasher.verify('correct horse battery staple', digest)).toBe(true);
    }, 30_000);

    it('verify() returns false for a different plaintext', async () => {
      const digest = await hasher.hash('correct horse battery staple');
      expect(await hasher.verify('wrong password!!', digest)).toBe(false);
    }, 30_000);

    it('two hashes of the same plaintext differ (per-input salt)', async () => {
      const a = await hasher.hash('same input');
      const b = await hasher.hash('same input');
      expect(a).not.toBe(b);
      // But both must verify against the same plaintext.
      expect(await hasher.verify('same input', a)).toBe(true);
      expect(await hasher.verify('same input', b)).toBe(true);
    }, 30_000);
  });

  describe('inspectCost()', () => {
    it('returns the embedded cost from a well-formed digest', async () => {
      const digest = await hasher.hash('any password');
      expect(hasher.inspectCost(digest)).toBe(BCRYPT_COST_FACTOR);
    }, 30_000);

    it('returns null for non-bcrypt strings', () => {
      expect(hasher.inspectCost('')).toBeNull();
      expect(hasher.inspectCost('plaintext')).toBeNull();
      expect(hasher.inspectCost('$1$...')).toBeNull();
    });

    it('returns null for malformed bcrypt strings', () => {
      // Cost segment is not two digits.
      expect(
        hasher.inspectCost('$2b$ab$saltsaltsaltsaltsaltsahashhashhashhashhashhashhashhash'),
      ).toBeNull();
    });
  });
});
