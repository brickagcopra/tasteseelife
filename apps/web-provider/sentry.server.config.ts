/**
 * Sentry for the web-provider Node runtime — server actions, RSC fetches and
 * route handlers (CLAUDE.md §10, TS-504-followup-2a-1).
 *
 * Loaded by `instrumentation.ts` only when `NEXT_RUNTIME === 'nodejs'`. The
 * `@sentry/nextjs` import is HERE rather than in a shared package on purpose:
 * the SDK resolves to a different build per runtime through its package
 * `exports` conditions, and that only happens in the module webpack is
 * bundling for that runtime. Everything except the import is shared —
 * `portalSentryOptions` owns the decisions, so four portals cannot drift into
 * four redaction policies.
 *
 * `SENTRY_DSN` and `SERVICE_VERSION` are read here rather than inside the
 * shared helper so the env contract stays visible in this workspace's own
 * source — which is also what lets `k8s-required-env-coverage.test.ts` see
 * them as read (TS-504-followup-2b1).
 */

import * as Sentry from '@sentry/nextjs';
import { portalSentryOptions } from '@taste-and-see/sentry';

Sentry.init(
  portalSentryOptions({
    portal: 'web-provider',
    dsn: process.env['SENTRY_DSN'],
    environment: process.env['NODE_ENV'],
    version: process.env['SERVICE_VERSION'],
  }),
);
