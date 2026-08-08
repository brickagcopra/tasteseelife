import { describe, expect, it } from 'vitest';

import { TrustHeaderConfigError, validateTrustHeaderOptions } from './options';

describe('validateTrustHeaderOptions', () => {
  it('accepts a well-formed config', () => {
    const validated = validateTrustHeaderOptions({
      signingSecret: 't'.repeat(32),
      maxAgeSeconds: 60,
    });
    expect(validated.signingSecret).toBe('t'.repeat(32));
    expect(validated.maxAgeSeconds).toBe(60);
    expect(validated.futureToleranceSeconds).toBe(5);
  });

  it('honours an explicit futureToleranceSeconds', () => {
    const validated = validateTrustHeaderOptions({
      signingSecret: 't'.repeat(32),
      maxAgeSeconds: 60,
      futureToleranceSeconds: 0,
    });
    expect(validated.futureToleranceSeconds).toBe(0);
  });

  it('rejects a short signing secret', () => {
    expect(() => validateTrustHeaderOptions({ signingSecret: 'short', maxAgeSeconds: 60 })).toThrow(
      TrustHeaderConfigError,
    );
  });

  it('rejects a zero / negative / non-integer maxAgeSeconds', () => {
    expect(() =>
      validateTrustHeaderOptions({ signingSecret: 't'.repeat(32), maxAgeSeconds: 0 }),
    ).toThrow(TrustHeaderConfigError);
    expect(() =>
      validateTrustHeaderOptions({ signingSecret: 't'.repeat(32), maxAgeSeconds: -1 }),
    ).toThrow(TrustHeaderConfigError);
    expect(() =>
      validateTrustHeaderOptions({ signingSecret: 't'.repeat(32), maxAgeSeconds: 1.5 }),
    ).toThrow(TrustHeaderConfigError);
  });

  it('rejects maxAgeSeconds above 1 hour', () => {
    expect(() =>
      validateTrustHeaderOptions({ signingSecret: 't'.repeat(32), maxAgeSeconds: 3601 }),
    ).toThrow(TrustHeaderConfigError);
  });

  it('rejects a negative or non-integer futureToleranceSeconds', () => {
    expect(() =>
      validateTrustHeaderOptions({
        signingSecret: 't'.repeat(32),
        maxAgeSeconds: 60,
        futureToleranceSeconds: -1,
      }),
    ).toThrow(TrustHeaderConfigError);
    expect(() =>
      validateTrustHeaderOptions({
        signingSecret: 't'.repeat(32),
        maxAgeSeconds: 60,
        futureToleranceSeconds: 1.5,
      }),
    ).toThrow(TrustHeaderConfigError);
  });

  it('rejects futureToleranceSeconds above 60', () => {
    expect(() =>
      validateTrustHeaderOptions({
        signingSecret: 't'.repeat(32),
        maxAgeSeconds: 60,
        futureToleranceSeconds: 61,
      }),
    ).toThrow(TrustHeaderConfigError);
  });

  it('returns a frozen options object', () => {
    const validated = validateTrustHeaderOptions({
      signingSecret: 't'.repeat(32),
      maxAgeSeconds: 60,
    });
    expect(Object.isFrozen(validated)).toBe(true);
  });
});
