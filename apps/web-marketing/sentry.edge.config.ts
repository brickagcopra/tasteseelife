/**
 * Sentry for the web-marketing edge runtime — `middleware.ts` (CLAUDE.md §10,
 * TS-504-followup-2a-1).
 *
 * **web-marketing has no `middleware.ts` today**, so Next builds no edge
 * bundle and this module is never loaded. It is kept, identical to the other
 * three portals, so that adding a middleware here does not silently ship an
 * unobserved runtime — the failure would be invisible, because the guarded
 * branch in `instrumentation.ts` would simply never find anything to import.
 *
 * Identical options to the Node runtime, from the same shared builder. The
 * separate file exists because the edge bundle needs its own `@sentry/nextjs`
 * import to resolve the edge-light build — see `sentry.server.config.ts`.
 */

import * as Sentry from '@sentry/nextjs';
import { portalSentryOptions } from '@taste-and-see/sentry';

Sentry.init(
  portalSentryOptions({
    portal: 'web-marketing',
    dsn: process.env['SENTRY_DSN'],
    environment: process.env['NODE_ENV'],
    version: process.env['SERVICE_VERSION'],
  }),
);
