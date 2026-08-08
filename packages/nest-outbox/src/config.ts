import { z } from 'zod';

/**
 * Configuration accepted by `OutboxModule.forRoot`.
 *
 * `serviceName` is the producer's name (used in log lines + as the
 * `producer_service` column on every appended row so the relay's
 * observability surfaces "which service emitted this event").
 *
 * `schemaName` is the Postgres schema that owns the producer's
 * `outbox_events` table — e.g. `subscription` for service-subscription.
 * Schema names come from trusted module config (not user input), so the
 * SDK interpolates them into raw SQL identifiers; postgres does NOT
 * allow placeholders for identifiers (CLAUDE.md §4.1).
 *
 * `tableName` defaults to `outbox_events` — every service shares this
 * shape. Override only for migrations that need a temporary parallel
 * table (forward-compatible expand → migrate → contract per
 * CLAUDE.md §4.1).
 */
export interface OutboxModuleOptions {
  readonly serviceName: string;
  readonly schemaName: string;
  readonly tableName?: string;
  /**
   * Optional override of the `eventId` generator. Defaults to
   * `crypto.randomUUID()` (UUIDv4) — sufficient for dedup; relay
   * ordering uses `created_at` not the id, so non-time-sortable IDs
   * are fine. Consumers may pass a custom generator (CUID2, ULID,
   * etc.) without changing the schema.
   */
  readonly idGenerator?: () => string;
  /**
   * Optional override of the clock used for `occurredAt` defaults +
   * relay attempt timestamps. Defaults to `() => new Date()`. Tests
   * inject a fake clock to make timestamp assertions deterministic.
   */
  readonly clock?: () => Date;
}

const NonEmptyStringSchema = z.string().min(1);
const IdentifierSchema = z.string().regex(/^[a-z_][a-z0-9_]*$/, {
  message:
    'must be a lowercase ASCII identifier (letters, digits, underscore; not leading with a digit). The SDK interpolates this into raw SQL — non-identifier input is rejected.',
});

/**
 * Validate options at module construction time. Bootstrap-time misconfig
 * should fail loudly — silent fallback would invite "no events
 * being persisted" surprise in prod.
 */
export function validateOptions(options: OutboxModuleOptions): ValidatedOutboxOptions {
  const issues: string[] = [];

  if (!NonEmptyStringSchema.safeParse(options.serviceName).success) {
    issues.push('serviceName must be a non-empty string');
  }

  const schemaParse = IdentifierSchema.safeParse(options.schemaName);
  if (!schemaParse.success) {
    issues.push(`schemaName: ${schemaParse.error.issues[0]?.message ?? 'invalid'}`);
  }

  const tableName = options.tableName ?? 'outbox_events';
  const tableParse = IdentifierSchema.safeParse(tableName);
  if (!tableParse.success) {
    issues.push(`tableName: ${tableParse.error.issues[0]?.message ?? 'invalid'}`);
  }

  if (issues.length > 0) {
    throw new OutboxConfigError(issues);
  }

  return {
    serviceName: options.serviceName,
    schemaName: options.schemaName,
    tableName,
    idGenerator: options.idGenerator ?? defaultIdGenerator,
    clock: options.clock ?? defaultClock,
  };
}

export interface ValidatedOutboxOptions {
  readonly serviceName: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly idGenerator: () => string;
  readonly clock: () => Date;
}

export class OutboxConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`@taste-and-see/nest-outbox: invalid options — ${issues.join('; ')}`);
    this.name = 'OutboxConfigError';
  }
}

function defaultIdGenerator(): string {
  // `crypto.randomUUID` is on the global since Node 14.17+ and is the
  // approved primitive in CLAUDE.md §4.1 ("CUID2 or UUIDv7"; UUIDv4 is
  // a strict superset of the dedup guarantees we need at the event_id
  // level — the relay sorts by created_at, not by the id).
  return globalThis.crypto.randomUUID();
}

function defaultClock(): Date {
  return new Date();
}
