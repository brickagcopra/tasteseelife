import { type EventName, eventRegistry, getEventSchema } from '@taste-and-see/contracts';

import type { ParsedStreamEntry } from './types';

/**
 * Runtime guard against the event registry. The contracts package
 * exports the registry shape + `EventName` keyof, but not a
 * value-level type predicate; the SDK declares one locally so
 * unknown event names from the bus surface as a structured invalid
 * entry rather than a `as EventName` cast.
 */
function isEventName(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(eventRegistry, name);
}

/**
 * Discriminated-union result of parsing a single Redis stream entry's
 * key-value pair list. `ok` means the entry is well-formed AND the
 * payload validates against the matching registry schema; `invalid`
 * means we should NOT invoke the handler — the SDK escalates a
 * permanent malformed entry directly to the dead-letter path so it
 * doesn't loop forever in the PEL.
 */
export type ParseResult =
  | { readonly kind: 'ok'; readonly entry: ParsedStreamEntry }
  | {
      readonly kind: 'invalid';
      readonly streamId: string;
      readonly eventId: string | null;
      readonly eventName: string | null;
      readonly reason: string;
    };

/**
 * Parse a raw XREADGROUP entry shape into our typed envelope. ioredis
 * surfaces each entry as `[streamId, [k1, v1, k2, v2, ...]]`. The
 * relay writes a fixed key set (see RedisStreamPublisher); the parser
 * tolerates field reordering but rejects entries missing a required
 * field.
 *
 * The payload field carries a JSON-stringified body; we parse JSON +
 * validate against the registry schema before constructing the typed
 * entry. A JSON parse failure or a schema mismatch surfaces as
 * `invalid` — the caller decides whether to dead-letter immediately or
 * retry (the SDK dead-letters because a malformed payload is permanent).
 */
export function parseStreamEntry(streamId: string, rawFields: readonly string[]): ParseResult {
  const fields = pairsToMap(rawFields);

  const eventId = fields.get('event_id') ?? null;
  const eventName = fields.get('event_name') ?? null;
  if (eventId === null) {
    return {
      kind: 'invalid',
      streamId,
      eventId: null,
      eventName,
      reason: 'missing field: event_id',
    };
  }
  if (eventName === null) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName: null,
      reason: 'missing field: event_name',
    };
  }

  if (!isEventName(eventName)) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: `unknown event_name '${eventName}' — not present in eventRegistry`,
    };
  }

  const payloadRaw = fields.get('payload');
  if (payloadRaw === undefined) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: 'missing field: payload',
    };
  }
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadRaw);
  } catch (e) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: `payload JSON parse failed: ${messageOf(e)}`,
    };
  }

  const schema = getEventSchema(eventName);
  // `getEventSchema` returns undefined only for unknown names, which
  // `isEventName` already rejected — but the runtime guard keeps the
  // types honest.
  if (schema === undefined) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: `registry schema lookup returned undefined for '${eventName}' (registry / isEventName drift)`,
    };
  }
  const parsed = schema.safeParse(payloadJson);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: `payload schema validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    };
  }

  const occurredAtRaw = fields.get('occurred_at');
  if (occurredAtRaw === undefined) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: 'missing field: occurred_at',
    };
  }
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return {
      kind: 'invalid',
      streamId,
      eventId,
      eventName,
      reason: `occurred_at not parseable: '${occurredAtRaw}'`,
    };
  }

  return {
    kind: 'ok',
    entry: {
      streamId,
      eventId,
      eventName: eventName satisfies EventName,
      payload: parsed.data,
      occurredAt,
      producerService: fields.get('producer_service') ?? '<unknown>',
      producerSchema: fields.get('schema') ?? '<unknown>',
    },
  };
}

function pairsToMap(pairs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const key = pairs[i];
    const val = pairs[i + 1];
    if (typeof key !== 'string' || typeof val !== 'string') continue;
    out.set(key, val);
  }
  return out;
}

function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
}
