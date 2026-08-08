import { harnessPrisma } from './harness-db';

/**
 * Reads domain events out of a service's outbox (TS-505).
 *
 * **Why the suite reads events at all.** Several platform behaviours the money
 * path depends on are delivered as events, not as HTTP responses — the
 * email-verification token (TS-510) is the first, and the accounting journal
 * that a completed booking posts will be another. For those, the outbox row IS
 * the observable outcome, and the suite stands in for the consumer that will
 * eventually drain it. Asserting against the event rather than against a
 * private table means the suite exercises the same contract the real consumer
 * will: if the payload shape drifts, both break together.
 *
 * The reads here are strictly read-only. The connection itself, and the
 * justification for the harness holding one at all, live in `harness-db.ts`.
 */

const prisma = harnessPrisma;

/**
 * Producer schemas whose outbox the harness may read.
 *
 * An allow-list rather than a free string because the schema is interpolated
 * into raw SQL — the same reason the relay's own `OUTBOX_SOURCES` validates
 * against an identifier regex. A caller cannot reach a table this list does
 * not name, and adding one is a deliberate edit.
 */
const OUTBOX_SCHEMAS = ['identity', 'booking', 'accounting'] as const;
export type OutboxSchema = (typeof OUTBOX_SCHEMAS)[number];

export interface OutboxEvent {
  readonly eventId: string;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

/**
 * Wait for an outbox event matching `eventName` whose payload satisfies
 * `matches`, or throw with a diagnosable message.
 *
 * Polls rather than subscribes, because the outbox is a table and the producer
 * commits it inside a transaction the suite has no hook into. The budget is an
 * argument with a small default: an event appended in the same transaction as
 * the HTTP response's own write is already committed by the time the response
 * is read, so a long wait here would mean something is wrong, not slow.
 *
 * The failure message reports how many events of that name were seen, because
 * "none at all" (the producer never ran) and "several, none matching" (the
 * predicate or the payload is wrong) are different bugs.
 */
export async function waitForOutboxEvent(
  eventName: string,
  matches: (payload: Record<string, unknown>) => boolean,
  options: { readonly timeoutMs?: number; readonly schema?: OutboxSchema } = {},
): Promise<OutboxEvent> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const schema = options.schema ?? 'identity';
  if (!OUTBOX_SCHEMAS.includes(schema)) {
    throw new Error(`Unknown outbox schema '${schema}'`);
  }
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  for (;;) {
    const rows = await prisma().$queryRawUnsafe<
      { event_id: string; event_name: string; payload: unknown; occurred_at: Date }[]
    >(
      `SELECT event_id, event_name, payload, occurred_at FROM ${schema}.outbox_events ` +
        `WHERE event_name = $1 ORDER BY created_at DESC LIMIT 200`,
      eventName,
    );
    seen = rows.length;

    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      if (matches(payload)) {
        return {
          eventId: row.event_id,
          eventName: row.event_name,
          payload,
          occurredAt: row.occurred_at,
        };
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `No '${eventName}' outbox event matched in ${schema}.outbox_events within ` +
          `${String(timeoutMs)}ms (${String(seen)} event${seen === 1 ? '' : 's'} ` +
          `of that name present).`,
      );
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}
