import type { Env } from '../config/env';

/**
 * A single table the janitor sweeps. The `schema` / `table` /
 * `expiresAtColumn` identifiers are CODE CONSTANTS defined below — they
 * are never sourced from env or any request, so the raw SQL the
 * repository interpolates them into carries no injection surface. Only
 * `retentionDays` + `enabled` are operator-tunable (via env).
 */
export interface PruneTarget {
  /** Stable short key for log lines + (future) metric labels. */
  readonly key: string;
  /** Postgres schema — constant. */
  readonly schema: string;
  /** Table name — constant. */
  readonly table: string;
  /** Timestamptz column the retention threshold compares against — constant. */
  readonly expiresAtColumn: string;
  /** Whole days past `expiresAtColumn` a row must be before it is eligible for deletion. */
  readonly retentionDays: number;
  /** When false, the sweep skips this target entirely. */
  readonly enabled: boolean;
}

/**
 * The fixed set of identity-schema tables this worker is allowed to
 * touch. Adding a table here is a deliberate, reviewed code change —
 * the worker can never be pointed at an arbitrary table via config.
 *
 * Both tables carry an index on their `expires_at` column
 * (`refresh_tokens_expires_at_idx` / `mfa_challenges_expires_at_idx`)
 * so the retention range scan the repository issues is cheap
 * regardless of table size.
 */
const REFRESH_TOKENS = {
  key: 'refresh_tokens',
  schema: 'identity',
  table: 'refresh_tokens',
  expiresAtColumn: 'expires_at',
} as const;

const MFA_CHALLENGES = {
  key: 'mfa_challenges',
  schema: 'identity',
  table: 'mfa_challenges',
  expiresAtColumn: 'expires_at',
} as const;

/**
 * Build the runtime target list from env. Pure — no I/O — so the
 * mapping from env knobs to targets is unit-testable in isolation.
 *
 * Disabled targets are still returned (with `enabled: false`) so the
 * worker can log a deterministic "skipped" line per sweep rather than
 * silently dropping a table from the cadence.
 */
export function buildPruneTargets(env: Env): readonly PruneTarget[] {
  return [
    {
      ...REFRESH_TOKENS,
      retentionDays: env.REFRESH_TOKEN_RETENTION_DAYS,
      enabled: env.REFRESH_TOKEN_PRUNE_ENABLED,
    },
    {
      ...MFA_CHALLENGES,
      retentionDays: env.MFA_CHALLENGE_RETENTION_DAYS,
      enabled: env.MFA_CHALLENGE_PRUNE_ENABLED,
    },
  ];
}
