import { describe, expect, it } from 'vitest';

import {
  LoginChallengeResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LoginSessionResponseSchema,
  MfaConfirmRequestSchema,
  MfaConfirmResponseSchema,
  MfaEnrollRequestSchema,
  MfaEnrollResponseSchema,
  MfaListResponseSchema,
  MfaMethodSummarySchema,
  MfaRecoveryVerifyRequestSchema,
  MfaRemoveResponseSchema,
  MfaVerifyRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RefreshResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  UserStatusSchema,
  type LoginChallengeResponse,
  type LoginRequest,
  type LoginSessionResponse,
  type MfaConfirmRequest,
  type MfaEnrollResponse,
  type MfaMethodSummary,
  type MfaRecoveryVerifyRequest,
  type MfaVerifyRequest,
  type RefreshResponse,
  type SignupRequest,
  type SignupResponse,
} from '../http/auth.schema';

const validSignup: SignupRequest = {
  email: 'alice@example.com',
  phone: '+14155551212',
  password: 'correct horse battery staple',
};

describe('SignupRequestSchema', () => {
  it('accepts a fully-populated valid request', () => {
    expect(SignupRequestSchema.parse(validSignup)).toEqual(validSignup);
  });

  it('accepts a request without phone (phone is optional)', () => {
    const { phone, ...withoutPhone } = validSignup;
    void phone;
    const parsed = SignupRequestSchema.parse(withoutPhone);
    expect(parsed.phone).toBeUndefined();
    expect(parsed.email).toBe(validSignup.email);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    const result = SignupRequestSchema.safeParse({
      ...validSignup,
      role: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(SignupRequestSchema.safeParse({ ...validSignup, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it('rejects an over-long email', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(180)}.example.com`;
    const overLong = `${local}@${domain}`;
    expect(overLong.length).toBeGreaterThan(254);
    expect(SignupRequestSchema.safeParse({ ...validSignup, email: overLong }).success).toBe(false);
  });

  it('rejects malformed phone numbers', () => {
    expect(SignupRequestSchema.safeParse({ ...validSignup, phone: '415-555-1212' }).success).toBe(
      false,
    );
    expect(SignupRequestSchema.safeParse({ ...validSignup, phone: '+0123456789' }).success).toBe(
      false,
    );
    expect(SignupRequestSchema.safeParse({ ...validSignup, phone: '12345' }).success).toBe(false);
  });

  it('accepts E.164 phone numbers with and without leading +', () => {
    expect(SignupRequestSchema.safeParse({ ...validSignup, phone: '14155551212' }).success).toBe(
      true,
    );
    expect(SignupRequestSchema.safeParse({ ...validSignup, phone: '+14155551212' }).success).toBe(
      true,
    );
  });

  it(`rejects passwords shorter than ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(
      SignupRequestSchema.safeParse({
        ...validSignup,
        password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
      }).success,
    ).toBe(false);
  });

  it(`accepts passwords exactly ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(
      SignupRequestSchema.safeParse({ ...validSignup, password: 'a'.repeat(PASSWORD_MIN_LENGTH) })
        .success,
    ).toBe(true);
  });

  it(`rejects passwords longer than ${PASSWORD_MAX_LENGTH} characters`, () => {
    expect(
      SignupRequestSchema.safeParse({
        ...validSignup,
        password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it(`accepts passwords exactly ${PASSWORD_MAX_LENGTH} characters`, () => {
    expect(
      SignupRequestSchema.safeParse({ ...validSignup, password: 'a'.repeat(PASSWORD_MAX_LENGTH) })
        .success,
    ).toBe(true);
  });

  it('does not enforce composition rules (NIST SP 800-63B §5.1.1.2)', () => {
    // No upper-case, no digit, no symbol — must still pass.
    expect(
      SignupRequestSchema.safeParse({ ...validSignup, password: 'lowercaseonly' }).success,
    ).toBe(true);
  });
});

describe('SignupResponseSchema', () => {
  const validResponse: SignupResponse = {
    id: 'cuid_abc',
    email: 'alice@example.com',
    phone: '+14155551212',
    status: 'pending_verification',
    createdAt: '2026-05-09T12:00:00.000Z',
  };

  it('accepts a valid response', () => {
    expect(SignupResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('accepts null phone', () => {
    expect(SignupResponseSchema.parse({ ...validResponse, phone: null }).phone).toBeNull();
  });

  it('rejects unknown fields (`.strict()`)', () => {
    const result = SignupResponseSchema.safeParse({
      ...validResponse,
      passwordHash: 'leak',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed createdAt', () => {
    expect(
      SignupResponseSchema.safeParse({ ...validResponse, createdAt: '2026-05-09' }).success,
    ).toBe(false);
  });
});

describe('UserStatusSchema', () => {
  it('accepts every documented lifecycle value', () => {
    for (const v of ['pending_verification', 'active', 'suspended', 'deactivated'] as const) {
      expect(UserStatusSchema.parse(v)).toBe(v);
    }
  });

  it('rejects values outside the enum', () => {
    expect(UserStatusSchema.safeParse('archived').success).toBe(false);
  });
});

describe('LoginRequestSchema', () => {
  const validLogin: LoginRequest = {
    email: 'alice@example.com',
    password: 'correct horse battery staple',
  };

  it('accepts a valid login payload', () => {
    expect(LoginRequestSchema.parse(validLogin)).toEqual(validLogin);
  });

  it('does not require email to be a syntactically valid address', () => {
    // Login is a credential check, not a registration — accepting any
    // string the user typed lets us yield a single 401 instead of a
    // 400 ("not a valid email") that leaks the account-doesn't-exist
    // signal indirectly.
    expect(LoginRequestSchema.safeParse({ ...validLogin, email: 'not-an-email' }).success).toBe(
      true,
    );
  });

  it('rejects an empty email', () => {
    expect(LoginRequestSchema.safeParse({ ...validLogin, email: '' }).success).toBe(false);
  });

  it('rejects an empty password', () => {
    expect(LoginRequestSchema.safeParse({ ...validLogin, password: '' }).success).toBe(false);
  });

  it('rejects a 1025-character password (DoS guard)', () => {
    expect(
      LoginRequestSchema.safeParse({ ...validLogin, password: 'a'.repeat(1025) }).success,
    ).toBe(false);
  });

  it('accepts a 1024-character password (boundary)', () => {
    expect(
      LoginRequestSchema.safeParse({ ...validLogin, password: 'a'.repeat(1024) }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(LoginRequestSchema.safeParse({ ...validLogin, mfaToken: '123456' }).success).toBe(false);
  });
});

describe('LoginSessionResponseSchema (outcome: "session")', () => {
  const validLoginResponse: LoginSessionResponse = {
    outcome: 'session',
    accessToken: 'eyJhbGc.eyJzdWI.signature',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: {
      id: 'u_1',
      email: 'alice@example.com',
      status: 'active',
    },
  };

  it('accepts a valid response', () => {
    expect(LoginSessionResponseSchema.parse(validLoginResponse)).toEqual(validLoginResponse);
    // And LoginResponseSchema (the discriminated union) accepts it too.
    expect(LoginResponseSchema.parse(validLoginResponse)).toEqual(validLoginResponse);
  });

  it('rejects when outcome is missing or wrong', () => {
    const { outcome, ...withoutOutcome } = validLoginResponse;
    void outcome;
    expect(LoginSessionResponseSchema.safeParse(withoutOutcome).success).toBe(false);
    expect(
      LoginResponseSchema.safeParse({ ...validLoginResponse, outcome: 'unknown' as 'session' })
        .success,
    ).toBe(false);
  });

  it('requires tokenType to be the literal `Bearer`', () => {
    expect(
      LoginSessionResponseSchema.safeParse({
        ...validLoginResponse,
        tokenType: 'JWT' as unknown as 'Bearer',
      }).success,
    ).toBe(false);
  });

  it('rejects negative expiresIn', () => {
    expect(
      LoginSessionResponseSchema.safeParse({ ...validLoginResponse, expiresIn: -1 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields anywhere (`.strict()`)', () => {
    expect(
      LoginSessionResponseSchema.safeParse({
        ...validLoginResponse,
        refreshToken: 'should-not-be-here',
      }).success,
    ).toBe(false);
    expect(
      LoginSessionResponseSchema.safeParse({
        ...validLoginResponse,
        user: { ...validLoginResponse.user, passwordHash: 'leak' },
      }).success,
    ).toBe(false);
    // A challenge-token field on the session branch is also a leak.
    expect(
      LoginSessionResponseSchema.safeParse({ ...validLoginResponse, challengeToken: 'leak' })
        .success,
    ).toBe(false);
  });

  it('requires user.status to be a valid UserStatus', () => {
    expect(
      LoginSessionResponseSchema.safeParse({
        ...validLoginResponse,
        user: { ...validLoginResponse.user, status: 'archived' as unknown as 'active' },
      }).success,
    ).toBe(false);
  });
});

describe('LoginChallengeResponseSchema (outcome: "challenge")', () => {
  const validChallenge: LoginChallengeResponse = {
    outcome: 'challenge',
    challengeToken: 'eyJhbGc.eyJzdWI.signature',
    expiresIn: 300,
  };

  it('accepts a valid challenge response', () => {
    expect(LoginChallengeResponseSchema.parse(validChallenge)).toEqual(validChallenge);
    expect(LoginResponseSchema.parse(validChallenge)).toEqual(validChallenge);
  });

  it('rejects user information leaking into the challenge branch', () => {
    expect(
      LoginChallengeResponseSchema.safeParse({
        ...validChallenge,
        user: { id: 'u_1', email: 'a@x', status: 'active' },
      }).success,
    ).toBe(false);
  });

  it('rejects an access-token field on the challenge branch (would defeat MFA)', () => {
    expect(
      LoginChallengeResponseSchema.safeParse({ ...validChallenge, accessToken: 'eyJ' }).success,
    ).toBe(false);
  });

  it('rejects empty challengeToken', () => {
    expect(
      LoginChallengeResponseSchema.safeParse({ ...validChallenge, challengeToken: '' }).success,
    ).toBe(false);
  });
});

describe('LoginResponseSchema (discriminated union)', () => {
  it('discriminator-narrows on `outcome` so each branch enforces its own shape', () => {
    // A challenge body with a `tokenType` field is rejected — `tokenType` is not
    // a known field on the challenge branch.
    expect(
      LoginResponseSchema.safeParse({
        outcome: 'challenge',
        challengeToken: 'x',
        expiresIn: 300,
        tokenType: 'Bearer',
      }).success,
    ).toBe(false);
    // A session body with a `challengeToken` field is rejected too.
    expect(
      LoginResponseSchema.safeParse({
        outcome: 'session',
        accessToken: 'x',
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { id: 'u_1', email: 'a@x', status: 'active' },
        challengeToken: 'leak',
      }).success,
    ).toBe(false);
  });
});

describe('MfaEnrollRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(MfaEnrollRequestSchema.parse({})).toEqual({});
  });

  it('accepts an optional label', () => {
    const parsed = MfaEnrollRequestSchema.parse({ label: 'iPhone' });
    expect(parsed.label).toBe('iPhone');
  });

  it('rejects an over-long label', () => {
    expect(MfaEnrollRequestSchema.safeParse({ label: 'a'.repeat(65) }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(MfaEnrollRequestSchema.safeParse({ secret: 'JBSWY...' }).success).toBe(false);
  });
});

describe('MfaEnrollResponseSchema', () => {
  const valid: MfaEnrollResponse = {
    methodId: 'mfa_1',
    secretBase32: 'JBSWY3DPEHPK3PXP',
    otpauthUrl: 'otpauth://totp/Taste:alice?secret=JBSWY3DPEHPK3PXP',
  };

  it('accepts a valid response', () => {
    expect(MfaEnrollResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an otpauthUrl that does not start with otpauth://', () => {
    expect(
      MfaEnrollResponseSchema.safeParse({ ...valid, otpauthUrl: 'https://example.com' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (no secret rotation hints)', () => {
    expect(MfaEnrollResponseSchema.safeParse({ ...valid, keyVersion: 1 }).success).toBe(false);
  });
});

describe('MfaConfirmRequestSchema', () => {
  const valid: MfaConfirmRequest = { methodId: 'mfa_1', code: '123456' };

  it('accepts a valid request', () => {
    expect(MfaConfirmRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a 5-digit code', () => {
    expect(MfaConfirmRequestSchema.safeParse({ ...valid, code: '12345' }).success).toBe(false);
  });

  it('rejects a 7-digit code', () => {
    expect(MfaConfirmRequestSchema.safeParse({ ...valid, code: '1234567' }).success).toBe(false);
  });

  it('rejects a non-numeric code', () => {
    expect(MfaConfirmRequestSchema.safeParse({ ...valid, code: 'abcdef' }).success).toBe(false);
  });
});

describe('MfaConfirmResponseSchema', () => {
  // TS-023-followup-2: confirm now returns the freshly minted one-time
  // recovery codes alongside the mfaEnabled flag.
  const codes = Array.from({ length: 10 }, (_, i) => `ABCDE-FGH${i}K`);

  it('accepts {mfaEnabled: true, recoveryCodes: [...]}', () => {
    expect(MfaConfirmResponseSchema.parse({ mfaEnabled: true, recoveryCodes: codes })).toEqual({
      mfaEnabled: true,
      recoveryCodes: codes,
    });
  });

  it('rejects {mfaEnabled: false}', () => {
    // Confirm always succeeds with mfaEnabled === true; false would
    // be a contract bug.
    expect(
      MfaConfirmResponseSchema.safeParse({ mfaEnabled: false as true, recoveryCodes: codes })
        .success,
    ).toBe(false);
  });

  it('rejects a missing recoveryCodes array', () => {
    expect(MfaConfirmResponseSchema.safeParse({ mfaEnabled: true }).success).toBe(false);
  });

  it('rejects fewer than 8 codes', () => {
    expect(
      MfaConfirmResponseSchema.safeParse({ mfaEnabled: true, recoveryCodes: codes.slice(0, 7) })
        .success,
    ).toBe(false);
  });

  it('rejects a malformed recovery code (not grouped Crockford base32)', () => {
    expect(
      MfaConfirmResponseSchema.safeParse({
        mfaEnabled: true,
        recoveryCodes: [...codes.slice(0, 9), 'lowercase!'],
      }).success,
    ).toBe(false);
  });
});

describe('MfaVerifyRequestSchema', () => {
  const valid: MfaVerifyRequest = { challengeToken: 'eyJ.x.y', code: '654321' };

  it('accepts a valid request', () => {
    expect(MfaVerifyRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects empty challengeToken', () => {
    expect(MfaVerifyRequestSchema.safeParse({ ...valid, challengeToken: '' }).success).toBe(false);
  });

  it('rejects malformed code', () => {
    expect(MfaVerifyRequestSchema.safeParse({ ...valid, code: '12 456' }).success).toBe(false);
  });
});

describe('MfaRecoveryVerifyRequestSchema (TS-023-followup-2)', () => {
  const valid: MfaRecoveryVerifyRequest = {
    challengeToken: 'eyJ.x.y',
    recoveryCode: 'ABCDE-FGHJK',
  };

  it('accepts a valid request', () => {
    expect(MfaRecoveryVerifyRequestSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a de-dashed recovery code (server normalises)', () => {
    expect(
      MfaRecoveryVerifyRequestSchema.safeParse({ ...valid, recoveryCode: 'ABCDEFGHJK' }).success,
    ).toBe(true);
  });

  it('rejects empty challengeToken', () => {
    expect(MfaRecoveryVerifyRequestSchema.safeParse({ ...valid, challengeToken: '' }).success).toBe(
      false,
    );
  });

  it('rejects a too-short recovery code', () => {
    expect(
      MfaRecoveryVerifyRequestSchema.safeParse({ ...valid, recoveryCode: 'short' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(MfaRecoveryVerifyRequestSchema.safeParse({ ...valid, code: '123456' }).success).toBe(
      false,
    );
  });
});

describe('MfaMethodSummarySchema + MfaListResponseSchema', () => {
  const summary: MfaMethodSummary = {
    id: 'mfa_1',
    kind: 'totp',
    label: 'iPhone',
    confirmedAt: '2026-05-09T12:00:00.000Z',
    lastUsedAt: null,
    createdAt: '2026-05-09T11:59:30.000Z',
  };

  it('accepts a confirmed method summary', () => {
    expect(MfaMethodSummarySchema.parse(summary)).toEqual(summary);
  });

  it('accepts a null label and null confirmedAt (in-flight enrollment)', () => {
    expect(MfaMethodSummarySchema.parse({ ...summary, label: null, confirmedAt: null })).toEqual({
      ...summary,
      label: null,
      confirmedAt: null,
    });
  });

  it('rejects unknown fields (no secret material in the summary)', () => {
    expect(MfaMethodSummarySchema.safeParse({ ...summary, secretBase32: 'leak' }).success).toBe(
      false,
    );
  });

  it('list wraps an array of summaries', () => {
    expect(MfaListResponseSchema.parse({ methods: [summary] })).toEqual({ methods: [summary] });
  });
});

describe('MfaRemoveResponseSchema', () => {
  it('accepts {removed: true}', () => {
    expect(MfaRemoveResponseSchema.parse({ removed: true })).toEqual({ removed: true });
  });
});

describe('RefreshResponseSchema', () => {
  const validRefreshResponse: RefreshResponse = {
    accessToken: 'eyJhbGc.eyJzdWI.signature',
    tokenType: 'Bearer',
    expiresIn: 900,
  };

  it('accepts a valid response', () => {
    expect(RefreshResponseSchema.parse(validRefreshResponse)).toEqual(validRefreshResponse);
  });

  it('rejects unknown fields (no refresh token in body!)', () => {
    expect(
      RefreshResponseSchema.safeParse({
        ...validRefreshResponse,
        refreshToken: 'leak',
      }).success,
    ).toBe(false);
  });
});
