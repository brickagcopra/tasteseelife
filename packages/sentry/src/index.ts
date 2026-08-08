/**
 * SDK-free surface of `@taste-and-see/sentry`.
 *
 * Nothing here imports `@sentry/node` at runtime (the Sentry types are
 * type-only imports and erase at compile time), so the Next.js portals can
 * import these rules alongside `@sentry/nextjs` and share one set of
 * redaction decisions with the 24 Nest workloads. The Node bootstrap lives
 * behind the `./node` subpath.
 */

export {
  CREDENTIAL_KEY_PATTERNS,
  REDACTION_CENSOR,
  SENSITIVE_KEY_NAMES,
  isSensitiveKey,
} from './redaction';

export { portalSentryOptions } from './portal';
export type { PortalSentryInput, PortalSentryOptions } from './portal';

export { scrubBreadcrumb, scrubQueryString, scrubSentryEvent, scrubUrl, scrubValue } from './scrub';
