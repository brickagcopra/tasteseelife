/**
 * Sentry for the web-admin edge runtime — `middleware.ts` (CLAUDE.md §10,
 * TS-504-followup-2a-1).
 *
 * The middleware is where a session cookie is read and an unauthenticated
 * request is redirected, so a throw here fails the request before any page
 * code runs. It is a small amount of code and the least observable place in
 * the portal, which is exactly why it is worth wiring.
 *
 * Identical options to the Node runtime, from the same shared builder. The
 * separate file exists because the edge bundle needs its own `@sentry/nextjs`
 * import to resolve the edge-light build — see `sentry.server.config.ts`.
 */

import * as Sentry from '@sentry/nextjs';
import { portalSentryOptions } from '@taste-and-see/sentry';

Sentry.init(
  portalSentryOptions({
    portal: 'web-admin',
    dsn: process.env['SENTRY_DSN'],
    environment: process.env['NODE_ENV'],
    version: process.env['SERVICE_VERSION'],
  }),
);
