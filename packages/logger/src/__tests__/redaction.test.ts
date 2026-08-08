import { describe, expect, it } from 'vitest';

import { DEFAULT_REDACT_PATHS, REDACTION_CENSOR } from '../index';

describe('DEFAULT_REDACT_PATHS', () => {
  const paths = new Set(DEFAULT_REDACT_PATHS);

  it('covers every PII / credential category required by CLAUDE.md §10 and PDD §16.3', () => {
    const requiredTopLevel = [
      // Auth credentials
      'password',
      'passwordHash',
      'token',
      'accessToken',
      'refreshToken',
      'jwt',
      'authorization',
      'apiKey',
      'secret',
      // Personal identifiers (PII)
      'ssn',
      'dob',
      'email',
      'phone',
      // Payment-card primitives (PCI scope avoidance)
      'cardNumber',
      'pan',
      'cvv',
      // Health-flagged senior data (HIPAA-aligned)
      'dementiaStatus',
      'medicalNotes',
      'allergies',
      'medications',
    ];

    for (const required of requiredTopLevel) {
      expect(paths.has(required), `missing top-level redact path: ${required}`).toBe(true);
    }
  });

  it('includes one-level-deep wildcards for every PII / credential field name', () => {
    const requiredWildcards = [
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
      '*.ssn',
      '*.dob',
      '*.email',
      '*.phone',
      '*.cardNumber',
      '*.cvv',
      '*.dementiaStatus',
      '*.medicalNotes',
    ];

    for (const required of requiredWildcards) {
      expect(paths.has(required), `missing wildcard redact path: ${required}`).toBe(true);
    }
  });

  it('covers HTTP Authorization and Cookie headers under common request-object shapes', () => {
    expect(paths.has('req.headers.authorization')).toBe(true);
    expect(paths.has('req.headers.cookie')).toBe(true);
    expect(paths.has('request.headers.authorization')).toBe(true);
    expect(paths.has('headers.authorization')).toBe(true);
    expect(paths.has('res.headers["set-cookie"]')).toBe(true);
  });

  it('is frozen so mutations throw rather than silently weaken redaction at runtime', () => {
    expect(Object.isFrozen(DEFAULT_REDACT_PATHS)).toBe(true);
  });

  it('uses the [REDACTED] sentinel so log analytics can spot censored fields uniformly', () => {
    expect(REDACTION_CENSOR).toBe('[REDACTED]');
  });
});
