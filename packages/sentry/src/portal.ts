/**
 * Sentry options for the Next.js portals (CLAUDE.md §10, TS-504-followup-2a-1).
 *
 * ## Why this is a plain options object rather than an `init` function
 *
 * The 24 Nest workloads call `initSentry` from the `./node` subpath, which
 * owns its own `Sentry.init`. The portals cannot: `@sentry/nextjs` resolves to
 * a *different build per runtime* through its package `exports` conditions —
 * Node for server components and route handlers, edge-light for middleware —
 * and that resolution only happens when the importing module is the one
 * webpack is bundling for that runtime. A shared function that imported the
 * SDK would collapse those three builds into whichever one this package
 * resolved at compile time.
 *
 * TS-504-followup-2a-1's first attempt failed for exactly that reason, one
 * layer up: an `instrumentation.ts` that dynamically imported `@sentry/node`
 * behind a `NEXT_RUNTIME === 'nodejs'` guard does not build, because webpack
 * follows the import statically and compiles `instrumentation.ts` for the edge
 * runtime too. So the SDK import stays in the portal, where Next can see which
 * runtime it is compiling for, and only the *decisions* are shared.
 *
 * This file therefore imports no SDK at all and lives behind the package's
 * SDK-free `.` subpath, alongside the scrubbers it wires up.
 *
 * ## What the portals deliberately do NOT get
 *
 * **The browser SDK.** These portals render a named senior's care schedule,
 * wellness notes and household roster, and the browser SDK ships session
 * replay and DOM-interaction breadcrumbs. Recording that in a third-party
 * processor is a §12 / PDD §16.3 consent question, not a configuration
 * default — so there is no client config, and `portalSentryOptions` is only
 * ever handed to the server and edge runtimes. The errors worth having (server
 * actions, RSC fetches, route handlers, middleware) are all on this side of
 * that line.
 *
 * **Performance data.** `tracesSampleRate: 0`, set explicitly rather than left
 * undefined. A transaction name is a route pattern, but a span's attributes
 * carry full URLs, and a family portal's URLs contain household and senior
 * ids. This platform's performance data comes from the OTLP collector; the
 * portals are not yet wired to it, and an unreviewed side channel is not the
 * way to change that.
 */

import { scrubBreadcrumb, scrubSentryEvent } from './scrub';

export interface PortalSentryInput {
  /** Portal workspace name — becomes the `service` tag and the release prefix. Required. */
  portal: string;
  /** DSN, read by the caller so the env key stays visible in the portal's own source. */
  dsn?: string | undefined;
  /** Deployment environment label. Defaults to `development`. */
  environment?: string | undefined;
  /** Build / image version. Defaults to `dev`. */
  version?: string | undefined;
}

/**
 * The subset of Sentry's init options this platform sets.
 *
 * Structurally typed rather than imported from the SDK: the return value is
 * spread into `Sentry.init` at each portal, where the real option type is in
 * scope and will reject anything that does not fit. Declaring it here would
 * mean importing SDK types into a module whose whole purpose is not to.
 */
export interface PortalSentryOptions {
  readonly dsn: string | undefined;
  readonly environment: string;
  readonly release: string;
  readonly sendDefaultPii: false;
  readonly tracesSampleRate: 0;
  readonly beforeSend: typeof scrubSentryEvent;
  readonly beforeBreadcrumb: typeof scrubBreadcrumb;
  readonly initialScope: { readonly tags: { readonly service: string } };
}

/**
 * Build the init options for one portal runtime.
 *
 * An absent DSN is passed through as `undefined` rather than throwing:
 * `Sentry.init` treats that as "stay off", which is the right behaviour for a
 * developer running the portal locally. The operator-facing version of that
 * state — "production is running with no error tracker" — is the ConfigMap's
 * job, and `k8s-required-env-coverage.test.ts` is what keeps the key there.
 *
 * `sendDefaultPii: false` is set explicitly even though it is the SDK default,
 * for the same reason `initSentry` does: a default flipping in a major version
 * would be a silent PII regression, and §17.2 is not a best-effort rule.
 */
export function portalSentryOptions(input: PortalSentryInput): PortalSentryOptions {
  if (typeof input.portal !== 'string' || input.portal.length === 0) {
    throw new Error('portalSentryOptions: portal must be a non-empty string');
  }

  const version = input.version === undefined || input.version === '' ? 'dev' : input.version;

  return {
    // An empty string is Sentry's "configured to nothing", and the k8s
    // placeholder ships `SENTRY_DSN: ""` — so it has to mean off, not a DSN.
    dsn: input.dsn === undefined || input.dsn === '' ? undefined : input.dsn,
    environment:
      input.environment === undefined || input.environment === ''
        ? 'development'
        : input.environment,
    // `name@version`, matching the 24 Nest workloads. The portal name is part
    // of the release because four portals deploy at four independent versions;
    // a bare version string would attribute a family-portal regression to
    // whatever else shipped under that tag.
    release: `${input.portal}@${version}`,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: { tags: { service: input.portal } },
  };
}
