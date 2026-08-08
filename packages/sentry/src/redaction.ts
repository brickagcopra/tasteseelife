/**
 * Sensitive-key rules for Sentry event scrubbing (CLAUDE.md §10, §17.2).
 *
 * **There is exactly one PII list on this platform and it is not this file.**
 * `@taste-and-see/logger`'s `DEFAULT_REDACT_PATHS` is the source of truth;
 * everything below is derived from it. A second hand-maintained list is how
 * `medicalNotes` gets added to the logger in one PR and leaks to Sentry
 * forever after — the two would drift silently because neither side fails
 * when the other gains an entry.
 *
 * Two rules, because the key space has two shapes:
 *
 * 1. **Exact names**, derived from the logger paths. Those paths are written
 *    in pino `fast-redact` syntax (`password`, `*.password`,
 *    `req.headers.authorization`, `res.headers["set-cookie"]`), so we take the
 *    LAST segment of each and match it depth-agnostically. That is strictly
 *    stronger than pino's single-level `*.` wildcard, which is the right
 *    trade here: a Sentry event nests far deeper than a log line
 *    (`request.data.household.senior.email`, and stack-frame `vars`).
 *
 * 2. **Credential substrings**, because the platform's secret-bearing header
 *    names are open-ended and an enumeration would be stale on arrival. There
 *    are already three shapes in the gateway alone (`x-internal-api-key`,
 *    `x-household-memberships-internal-api-key`, `x-search-secret`) plus the
 *    signed `x-ts-trust-signature` from `@taste-and-see/nest-internal-trust`.
 *    A pattern covers the fourth one on the day it is invented; a list does
 *    not.
 *
 * **This deliberately over-redacts.** `tokenCount` and `tokenizer` match the
 * `token` pattern and will be censored. That is the correct direction of
 * error: an over-redacted field costs a debugging round trip, an
 * under-redacted one is a §17.2 violation that has already left the building.
 */

// The `/redaction` subpath, NOT the package barrel. The barrel re-exports
// `createLogger`, which pulls `pino` — a Node-only dependency that would be
// bundled into a Next.js portal's edge runtime along with these constants.
// This file is imported by the SDK-free `.` subpath precisely so the portals
// can share one PII list, so it must stay free of anything a portal cannot
// bundle. (The package doc-block already claimed this subpath was
// portal-ready; until this import changed, it was not.)
import { DEFAULT_REDACT_PATHS, REDACTION_CENSOR } from '@taste-and-see/logger/redaction';

export { REDACTION_CENSOR };

/**
 * Take the final segment of a pino redact path, normalised to lowercase.
 *
 *   `password`                    → `password`
 *   `*.accessToken`               → `accesstoken`
 *   `req.headers.authorization`   → `authorization`
 *   `res.headers["set-cookie"]`   → `set-cookie`
 */
function lastSegment(path: string): string {
  const bracket = /\[["']([^"']+)["']\]$/.exec(path);
  if (bracket?.[1] !== undefined) return bracket[1].toLowerCase();
  const parts = path.split('.');
  const last = parts[parts.length - 1];
  return (last ?? '').toLowerCase();
}

/**
 * Exact key names censored at any depth, derived from the logger's paths.
 * Lowercased — callers must lowercase the key before lookup, because body
 * fields arrive camelCase (`passwordHash`) while headers arrive lowercase.
 */
export const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  ...DEFAULT_REDACT_PATHS.map(lastSegment).filter((s) => s.length > 0 && s !== '*'),
  // Sentry-specific keys with no logger equivalent, because pino never sees
  // them: Sentry parses cookies into `request.cookies` (plural) rather than
  // leaving them on `headers.cookie`, and `set-cookie` may arrive as an
  // array under either name.
  'cookies',
  'set-cookie',
]);

/**
 * Substrings that mark a key as credential-bearing wherever it appears.
 * Matched against the lowercased key. See rule 2 in the file header for why
 * this is a pattern and not a list.
 */
export const CREDENTIAL_KEY_PATTERNS: readonly string[] = Object.freeze([
  'api-key',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'passwd',
  'password',
  'secret',
  'signature',
  'token',
]);

/**
 * True when `key` names a value that must never reach Sentry.
 *
 * Note what is NOT here: `x-ts-actor-user-id`, `x-ts-actor-roles` and
 * `x-ts-actor-tenant-scope` survive. They are the trust envelope's
 * non-secret half and they are exactly what makes an error report
 * actionable — who was acting, under what scope. The signature, which is
 * the only part worth forging, matches `signature` and is censored.
 */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SENSITIVE_KEY_NAMES.has(k)) return true;
  return CREDENTIAL_KEY_PATTERNS.some((pattern) => k.includes(pattern));
}
