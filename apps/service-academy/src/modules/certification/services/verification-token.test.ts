import { describe, expect, it } from 'vitest';

import { generateVerificationToken } from './verification-token';

describe('generateVerificationToken', () => {
  it('produces a url-safe base64url token within the contract cap', () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token.length).toBeLessThanOrEqual(64);
  });

  it('is effectively unique across calls', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateVerificationToken()));
    expect(tokens.size).toBe(1000);
  });
});
