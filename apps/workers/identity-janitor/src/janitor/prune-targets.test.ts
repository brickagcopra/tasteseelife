import { describe, expect, it } from 'vitest';

import { loadEnv } from '../config/env';

import { buildPruneTargets } from './prune-targets';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/identity',
};

describe('buildPruneTargets', () => {
  it('returns exactly the two identity-schema tables in order', () => {
    const targets = buildPruneTargets(loadEnv(baseEnv));

    expect(targets.map((t) => t.key)).toEqual(['refresh_tokens', 'mfa_challenges']);
  });

  it('pins the refresh-token target to identity.refresh_tokens.expires_at', () => {
    const [refreshTokens] = buildPruneTargets(loadEnv(baseEnv));

    expect(refreshTokens).toMatchObject({
      key: 'refresh_tokens',
      schema: 'identity',
      table: 'refresh_tokens',
      expiresAtColumn: 'expires_at',
    });
  });

  it('pins the mfa-challenge target to identity.mfa_challenges.expires_at', () => {
    const [, mfaChallenges] = buildPruneTargets(loadEnv(baseEnv));

    expect(mfaChallenges).toMatchObject({
      key: 'mfa_challenges',
      schema: 'identity',
      table: 'mfa_challenges',
      expiresAtColumn: 'expires_at',
    });
  });

  it('threads the per-target retention windows from env', () => {
    const targets = buildPruneTargets(
      loadEnv({
        ...baseEnv,
        REFRESH_TOKEN_RETENTION_DAYS: '14',
        MFA_CHALLENGE_RETENTION_DAYS: '3',
      }),
    );

    expect(targets[0]?.retentionDays).toBe(14);
    expect(targets[1]?.retentionDays).toBe(3);
  });

  it('threads the per-target enable flags from env', () => {
    const targets = buildPruneTargets(
      loadEnv({
        ...baseEnv,
        REFRESH_TOKEN_PRUNE_ENABLED: 'false',
        MFA_CHALLENGE_PRUNE_ENABLED: 'true',
      }),
    );

    expect(targets[0]?.enabled).toBe(false);
    expect(targets[1]?.enabled).toBe(true);
  });
});
