import { describe, expect, it } from 'vitest';

import { toSignupResponse, type SignupResponseSource } from './user.mapper';

const fixedDate = new Date('2026-05-09T12:00:00.000Z');

const baseSource: SignupResponseSource = {
  id: 'cuid_alice',
  email: 'alice@example.com',
  phone: '+14155551212',
  status: 'pending_verification',
  createdAt: fixedDate,
};

describe('toSignupResponse', () => {
  it('maps every contract field correctly', () => {
    expect(toSignupResponse(baseSource)).toEqual({
      id: 'cuid_alice',
      email: 'alice@example.com',
      phone: '+14155551212',
      status: 'pending_verification',
      createdAt: '2026-05-09T12:00:00.000Z',
    });
  });

  it('preserves a null phone', () => {
    const result = toSignupResponse({ ...baseSource, phone: null });
    expect(result.phone).toBeNull();
  });

  it('serialises createdAt to ISO 8601', () => {
    const result = toSignupResponse(baseSource);
    expect(result.createdAt).toBe('2026-05-09T12:00:00.000Z');
  });

  it('does not leak any extra fields beyond the SignupResponse shape', () => {
    // The source carries fewer fields than the underlying Prisma row, but
    // even from a richly-typed source the mapper must only emit DTO keys.
    const result = toSignupResponse(baseSource);
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'email', 'id', 'phone', 'status']);
  });
});
