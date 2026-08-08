/**
 * Next.js instrumentation hook for web-marketing (CLAUDE.md §10,
 * TS-504-followup-2a-1).
 *
 * **Why the two configs are separate modules behind a runtime guard.** Next
 * compiles this file for every runtime the app has — and every portal here has
 * a `middleware.ts`, so that includes edge. An earlier attempt at this task
 * put a guarded `await import('@taste-and-see/sentry/node')` here and did not
 * build: webpack follows the dynamic import statically regardless of the
 * runtime guard, and `@sentry/node` needs `worker_threads` / `perf_hooks` /
 * `diagnostics_channel`, none of which resolve on edge. `serverExternalPackages`
 * does not help — it does not apply to the edge bundle.
 *
 * `@sentry/nextjs` is the fix rather than a workaround: it publishes a build
 * per runtime under its `exports` conditions, so each of these two modules
 * resolves the SDK that fits the bundle it lands in.
 *
 * **There is no client config.** The browser SDK ships session replay and
 * DOM-interaction breadcrumbs, and this portal renders a named senior's care
 * schedule. That is a §12 / PDD §16.3 consent question rather than a
 * configuration default, so it stays off until someone decides otherwise in
 * writing.
 */

import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env['NEXT_RUNTIME'] === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Next 15's server-error hook. Without it, errors thrown inside a server
 * component or route handler are caught by Next's own boundary and never reach
 * an exception handler — the framework reports them to this callback instead.
 * Wiring `register` alone would have produced an initialised client that saw
 * almost nothing, which is the "instrumentation exists and reports nothing"
 * shape TS-306-followup-1c found.
 */
export const onRequestError = Sentry.captureRequestError;
