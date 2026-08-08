import { Inject, Injectable, Logger } from '@nestjs/common';
import { type EventName, eventRegistry, getEventSchema } from '@taste-and-see/contracts';

import type { ValidatedOutboxOptions } from '../config';
import { OUTBOX_OPTIONS_TOKEN } from '../module/tokens';
import type { AppendArgs, AppendResult, OutboxRawExecutor } from './types';

/**
 * Producer-side outbox API.
 *
 * Services call `append(tx, {eventName, payload})` inside the same
 * Prisma transaction as the state change so the event row commits
 * atomically with the business write (the outbox invariant from
 * PDD §7.3 / CLAUDE.md §5.3). If the transaction rolls back, the event
 * row goes with it — no orphan publish.
 *
 * The relay (`apps/worker-outbox-relay`) reads undispatched rows out
 * of the table the service migrates into its own schema and forwards
 * them to Redis Streams. Consumers must dedup on `event_id`.
 *
 * Why a service-level append and not a `RawSQL`-only helper. The
 * service is the place where event-name validation, payload
 * validation against the registry schema, eventId generation, and
 * clock injection compose cleanly — call sites stay a single line.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger('OutboxService');
  private readonly fullyQualifiedTable: string;

  constructor(
    @Inject(OUTBOX_OPTIONS_TOKEN)
    private readonly options: ValidatedOutboxOptions,
  ) {
    // Schema + table validated by `validateOptions` (identifier regex
    // rejects anything outside `[a-z_][a-z0-9_]*`), so the
    // interpolation here is safe by construction. Quoted to preserve
    // case sensitivity at the Postgres layer in case downstream
    // tooling ever introduces mixed-case identifiers (current Prisma
    // schemas never do — every owned schema is lowercase).
    this.fullyQualifiedTable = `"${options.schemaName}"."${options.tableName}"`;
  }

  /**
   * Append a domain event to the outbox.
   *
   * Must be called inside the caller's existing Prisma transaction
   * (pass the `tx` parameter from `prisma.$transaction`). Calling it
   * with the top-level `PrismaClient` is *allowed* but loses the
   * atomicity guarantee — the doc-comment is the only deterrent.
   *
   * Returns a `Result`-shaped object:
   *   - `kind: 'appended'` — row written, event_id + occurredAt
   *     returned for the caller to log / propagate.
   *   - `kind: 'validation_failed'` — payload did not parse against
   *     the event's registry schema. NO row is written; the caller
   *     decides whether to throw or surface a domain error.
   *
   * The validation step is the SDK's single quality gate: a malformed
   * payload at the producer never reaches the relay or any consumer.
   */
  async append<N extends EventName>(
    tx: OutboxRawExecutor,
    args: AppendArgs<N>,
  ): Promise<AppendResult> {
    const schema = getEventSchema(args.eventName);
    if (schema === undefined) {
      // Compile-time impossibility (EventName is a constrained union),
      // but the runtime guard exists for callers who cast.
      return {
        kind: 'validation_failed',
        eventName: args.eventName,
        issues: [
          {
            path: [],
            message: `unknown event name '${args.eventName}' — not present in eventRegistry`,
          },
        ],
      };
    }

    const parsed = schema.safeParse(args.payload);
    if (!parsed.success) {
      return {
        kind: 'validation_failed',
        eventName: args.eventName,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      };
    }

    const eventId = args.eventId ?? this.options.idGenerator();
    const occurredAt = args.occurredAt ?? this.options.clock();
    const payloadJson = JSON.stringify(parsed.data);

    // Raw SQL because the table identifier is parameterized by module
    // config (Postgres does not allow placeholders for identifiers).
    // Values use Prisma's tagged-template placeholder substitution so
    // payloads and timestamps stay parameterized — only the
    // schema-qualified table name is interpolated.
    //
    // Idempotency on (event_id) — relay-side replay protection. The
    // ON CONFLICT clause swallows a duplicate id (returns 0 rows
    // affected), letting the caller surface a deterministic
    // `appended` result without raising; the call site treats this
    // as an idempotent re-emit which is the right semantic for an
    // outbox.
    //
    // Note: `$executeRaw` returns the rows-affected count, not the
    // inserted row. The SDK does not need the round-trip data — the
    // appended eventId / occurredAt are known at the call site.
    const sql = `
      INSERT INTO ${this.fullyQualifiedTable}
        (event_id, event_name, payload, occurred_at, producer_service)
      VALUES
        ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (event_id) DO NOTHING
    `;

    // The Prisma raw-SQL signature is `$executeRaw(strings, ...values)`
    // for tagged templates, OR `$executeRawUnsafe(sql, ...values)` for
    // plain strings. Because the table is parameterized via module
    // config (already validated against an identifier regex), the
    // safer path is to use Prisma's `Prisma.sql` template at the call
    // site — but we don't want to take a Prisma import here. The
    // pragmatic shape: synthesise a TemplateStringsArray-shaped object
    // so `$executeRaw` works without `Prisma.sql`, while still
    // parameterizing every value.
    const strings = buildTemplateStrings(sql);

    await tx.$executeRaw(
      strings,
      eventId,
      args.eventName,
      payloadJson,
      occurredAt,
      this.options.serviceName,
    );

    this.log.debug(
      `outbox.append eventId=${eventId} name=${args.eventName} schema=${this.options.schemaName}`,
    );

    return {
      kind: 'appended',
      eventId,
      eventName: args.eventName,
      occurredAt,
    };
  }

  /** Internal: every event name the SDK can serialise. Exposed for tests. */
  knownEventNames(): readonly string[] {
    return Object.keys(eventRegistry);
  }
}

/**
 * Synthesise a `TemplateStringsArray`-shaped value so a plain SQL
 * string can be passed through Prisma's tagged-template
 * `$executeRaw(strings, ...values)` signature without an unsafe
 * cast at every call site.
 *
 * Prisma uses the tagged-template surface to detect literal SQL (vs.
 * `$executeRawUnsafe` for dynamic strings). For a fixed, validated
 * SQL string with `$N` placeholders, the safest path is to feed the
 * SQL through the tagged-template entrypoint — Prisma replaces the
 * `$N` placeholders with the supplied values, parameterized.
 *
 * The shape: a `TemplateStringsArray` is a string-indexed array with
 * a `raw` property pointing at the same array. For a SQL string with
 * N parameter placeholders, we need N+1 segments — Prisma splits on
 * the placeholders. Easiest approach: split the SQL on `$1..$N` and
 * present the segments. But Prisma's tagged-template entrypoint
 * doesn't actually use the segment splits — it treats every
 * placeholder as a single value position.
 *
 * The pragmatic shape used here splits the SQL on placeholder tokens
 * and presents the resulting segments as `TemplateStringsArray`. This
 * keeps the call site syntactic, parameterized, and unit-testable
 * with a fake `tx` that records the strings array + values exactly
 * as Prisma would receive them.
 */
function buildTemplateStrings(sql: string): TemplateStringsArray {
  // Split on `$N` placeholder tokens (one or more digits). The
  // resulting array has length N+1; .raw is the same array (the
  // outbox SDK never needs the raw vs. cooked distinction).
  const segments = sql.split(/\$\d+/);
  const arr: string[] & { raw?: readonly string[] } = segments;
  arr.raw = segments;
  return arr as unknown as TemplateStringsArray;
}
