import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/**
 * Per-resource SHA-256 hash chain for audit events (TS-100; CLAUDE.md
 * §3.6 "Hash chain across events for the same resource (current event
 * stores hash of previous)").
 *
 * **Why per-resource, not global.** PDD §17.1 + CLAUDE.md §3.6
 * specify the chain as "events for the same resource". A global chain
 * would force every audit write across the platform to serialise
 * through a single sequencer (a write to subscription X would block
 * the next write to booking Y until the first chain hash is
 * committed). Per-resource chaining matches the spec, keeps writes
 * parallelisable across resources, and makes the tamper-evident
 * invariant intuitive: tampering with a single event for resource X
 * invalidates every subsequent event for X (the chain breaks); other
 * resources' chains remain intact.
 *
 * **Canonical content.** The hash input is a deterministic JSON
 * serialisation of the event's content + the previous chain hash. The
 * field ordering is fixed by `CANONICAL_FIELD_ORDER` so two valid
 * serialisations of the same event produce the same hash; field
 * ordering drift is what makes naive `JSON.stringify` unsuitable for
 * cryptographic hashing.
 *
 * **Null handling.** `null` and `undefined` collapse to JSON `null` in
 * the canonical serialisation so the chain hash is stable across the
 * Prisma `null` ↔ TypeScript `undefined` boundary.
 *
 * **`chainPrevHash = null` for the first event.** The first event for
 * a resource has no predecessor; its chain hash is computed with
 * `chainPrevHash: null` baked into the canonical content.
 *
 * **Output.** Lowercase 64-char SHA-256 hex digest (32 bytes → 64
 * hex). The DB column is `CHAR(64)` — schemas line up.
 */
export interface ChainInput {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly actorTenantScopeType: string;
  readonly actorTenantScopeId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly beforeJson: unknown;
  readonly afterJson: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  /** SHA-256 hex digest of the previous event for this resource, or `null`. */
  readonly chainPrevHash: string | null;
}

/**
 * Canonical field order used by `compute()`. NEVER reorder — re-
 * ordering produces a different hash and breaks chain verification
 * against historical rows. Adding a NEW field is allowed only as a
 * future migration that re-chains every historical row under the new
 * canonical shape (a destructive op; would require an ADR).
 */
const CANONICAL_FIELD_ORDER: readonly (keyof ChainInput)[] = [
  'eventId',
  'occurredAt',
  'actorUserId',
  'actorRole',
  'actorTenantScopeType',
  'actorTenantScopeId',
  'action',
  'resourceKind',
  'resourceId',
  'beforeJson',
  'afterJson',
  'ip',
  'userAgent',
  'requestId',
  'traceId',
  'chainPrevHash',
];

@Injectable()
export class HashChainService {
  /**
   * Compute the SHA-256 chain hash for an event.
   *
   * Deterministic: equal inputs produce equal outputs across processes
   * and machines (no randomness, no clock dependency). Output is
   * lowercase 64-char hex; the DB column is `CHAR(64)`.
   */
  compute(input: ChainInput): string {
    const canonical = this.canonicalize(input);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Verify a previously-computed chain hash against an event's content
   * + the recorded `chainPrevHash`. Returns `true` when the hash
   * matches what `compute()` would produce for the same input.
   */
  verify(input: ChainInput, expectedHash: string): boolean {
    const computed = this.compute(input);
    return constantTimeEqual(computed, expectedHash);
  }

  /**
   * Build the canonical UTF-8 string fed into SHA-256.
   *
   * The function visibility is `public` for unit-test introspection
   * (a regression that silently changes the canonical shape would be
   * a chain-integrity catastrophe — explicit assertions on the exact
   * canonical bytes catch it). Production callers should use
   * `compute()` / `verify()` instead.
   */
  canonicalize(input: ChainInput): string {
    const parts: string[] = [];
    for (const field of CANONICAL_FIELD_ORDER) {
      const value = input[field];
      parts.push(`${field}=${canonicalizeValue(value)}`);
    }
    return parts.join('\n');
  }
}

/**
 * Convert one field's value to a canonical string. The rules:
 *
 *   - `undefined` / `null` → literal string `"null"` (collapses the
 *     Prisma `null` ↔ TypeScript `undefined` boundary).
 *   - `Date` → ISO-8601 string with the trailing `Z` (UTC). Dropping
 *     sub-millisecond precision is fine — Postgres `Timestamptz(6)`
 *     truncates beyond microseconds anyway, and the chain hash always
 *     re-computes against the persisted value.
 *   - `string` → the string itself, with newlines escaped so the
 *     `parts.join('\n')` separator in `canonicalize()` stays
 *     unambiguous.
 *   - any other primitive → the JS coercion to string via JSON.stringify.
 *   - objects / arrays → stable JSON via `stableStringify`. Field
 *     ordering is alphabetical, deeply.
 */
function canonicalizeValue(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return escapeNewlines(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return stableStringify(value);
}

/**
 * Stable JSON serialisation: arrays preserve order, objects sort keys
 * alphabetically (deep). The exact output is what gets hashed, so a
 * stable function is the contract — `JSON.stringify`'s default order
 * is insertion-order (V8-stable but spec-undefined), which is not
 * safe for cryptographic hashing.
 *
 * Cycles are not expected (the payload comes through Zod's
 * `JSON.stringify(...).length` cap which already rejects them); we
 * surface a clear error if one slips through.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => {
    if (raw === null) return null;
    if (typeof raw !== 'object') return raw;
    if (Array.isArray(raw)) return raw;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(raw as Record<string, unknown>).sort()) {
      sorted[k] = (raw as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

function escapeNewlines(s: string): string {
  // Replace literal newlines with `\n` (two chars) so the canonical
  // separator stays unambiguous. Tabs and the rest pass through —
  // they aren't separators in our canonical format.
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Constant-time-ish string equality for chain-hash verification.
 *
 * The default `===` short-circuits on the first differing byte, which
 * is a timing oracle. The hashes here are not secret per se (they're
 * already stored in the DB), but the verification surface may run in
 * adversarial contexts (e.g. a future "verify a tampered slice" admin
 * endpoint where the timing leak could narrow down WHICH event was
 * forged). Cost is trivial — 64 char loop — so the defensive shape is
 * worth it.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    // eslint-disable-next-line no-bitwise -- constant-time char-by-char XOR
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
