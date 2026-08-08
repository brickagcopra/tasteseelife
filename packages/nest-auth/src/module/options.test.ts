import { describe, expect, it } from 'vitest';

import {
  NestAuthConfigError,
  validateNestAuthOptions,
  type NestAuthModuleOptions,
} from './options';

const VALID: NestAuthModuleOptions = {
  jwtAccessSecret: 'a'.repeat(32),
  jwtIssuer: 'taste-and-see/service-identity',
  jwtAudience: 'taste-and-see/api',
};

describe('validateNestAuthOptions', () => {
  it('returns a frozen object on valid options', () => {
    const validated = validateNestAuthOptions(VALID);
    expect(validated.jwtAccessSecret).toBe(VALID.jwtAccessSecret);
    expect(validated.jwtIssuer).toBe(VALID.jwtIssuer);
    expect(validated.jwtAudience).toBe(VALID.jwtAudience);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('rejects a missing secret', () => {
    expect(() =>
      validateNestAuthOptions({ ...VALID, jwtAccessSecret: undefined as unknown as string }),
    ).toThrow(NestAuthConfigError);
  });

  it('rejects a short secret (< 32 chars)', () => {
    expect(() => validateNestAuthOptions({ ...VALID, jwtAccessSecret: 'a'.repeat(31) })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects a non-string secret', () => {
    expect(() =>
      validateNestAuthOptions({
        ...VALID,
        jwtAccessSecret: 12345 as unknown as string,
      }),
    ).toThrow(NestAuthConfigError);
  });

  it('rejects an empty issuer', () => {
    expect(() => validateNestAuthOptions({ ...VALID, jwtIssuer: '' })).toThrow(
      /jwtIssuer must be a non-empty string/,
    );
  });

  it('rejects a non-string issuer', () => {
    expect(() =>
      validateNestAuthOptions({
        ...VALID,
        jwtIssuer: null as unknown as string,
      }),
    ).toThrow(NestAuthConfigError);
  });

  it('rejects an empty audience', () => {
    expect(() => validateNestAuthOptions({ ...VALID, jwtAudience: '' })).toThrow(
      /jwtAudience must be a non-empty string/,
    );
  });

  it('rejects a non-string audience', () => {
    expect(() =>
      validateNestAuthOptions({
        ...VALID,
        jwtAudience: undefined as unknown as string,
      }),
    ).toThrow(NestAuthConfigError);
  });
});
