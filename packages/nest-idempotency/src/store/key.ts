import { createHash } from 'node:crypto';

/**
 * Format an idempotency Redis key following the CLAUDE.md §3.7
 * namespacing scheme:
 *
 *   `{env}:{service}:idempotency:{actor}:{sha256(rawKey)}`
 *
 * Components:
 *
 *   `env`     — `production` / `staging` / `dev` / `test`. Prevents
 *               cross-env collisions on a shared Redis (unlikely but
 *               cheap to defend).
 *   `service` — service name, e.g. `service-subscription`. Multi-tenant
 *               Redis across services without collision risk.
 *   `actor`   — stable per-request identity. Defaults to the
 *               authenticated user id; falls back to `anonymous` for
 *               pre-auth endpoints (signup). The actor scope prevents
 *               two unrelated clients with the same lucky Idempotency-Key
 *               from observing each other's cached responses.
 *   `sha256`  — hash the client-supplied key to a fixed 64-char hex
 *               string. Defeats key-length attacks against Redis memory
 *               (CLAUDE.md §3.4 generalised — never trust client-supplied
 *               sizes) and normalises trivial differences like trailing
 *               whitespace (we trim before hashing).
 *
 * The hash is one-way but not secret — same input, same output is the
 * whole point. It's stable across processes so the key Redis stores
 * matches the key Redis looks up.
 */
export function formatIdempotencyKey(parts: {
  readonly environment: string;
  readonly serviceName: string;
  readonly actor: string;
  readonly rawKey: string;
}): string {
  const env = sanitizeSegment(parts.environment, 'environment');
  const service = sanitizeSegment(parts.serviceName, 'serviceName');
  const actor = sanitizeSegment(parts.actor, 'actor');
  const hash = createHash('sha256').update(parts.rawKey.trim(), 'utf8').digest('hex');
  return `${env}:${service}:idempotency:${actor}:${hash}`;
}

/**
 * Compute a SHA-256 hash of the request body for the same-key-different-body
 * check.
 *
 * The body is whatever Express handed us — a parsed JSON object, an
 * array, a primitive, or `undefined` (no body / non-JSON). We re-stringify
 * via `JSON.stringify` so we hash a canonical-ish text form; this is
 * sufficient for client retry safety (same retry → same parsed shape →
 * same hash). Deep key ordering is intentionally NOT sorted — Stripe's
 * own behaviour hashes raw bytes; matching that posture means a client
 * who serialises keys in a different order on retry would see a 409,
 * which surfaces the bug rather than masking it.
 *
 * Returns the hex SHA-256 (64 chars).
 */
export function hashRequestBody(body: unknown): string {
  const serialised = body === undefined ? '' : (JSON.stringify(body) ?? '');
  return createHash('sha256').update(serialised, 'utf8').digest('hex');
}

/**
 * Reject path-traversal-ish characters that would break the Redis key
 * structure (`:` is the segment delimiter; whitespace is invisible and
 * confusing). Thrown errors here are bootstrap-time misconfigurations,
 * not request-time failures, so a hard throw is appropriate.
 */
function sanitizeSegment(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`@taste-and-see/nest-idempotency: ${name} must be a non-empty string`);
  }
  if (/[\s:]/.test(value)) {
    throw new Error(
      `@taste-and-see/nest-idempotency: ${name} must not contain whitespace or ':' (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}
