import Stripe from 'stripe';

import type { Env } from '../../config/env';

/**
 * The API key `service-webhook` is constructed with.
 *
 * Deliberately not credential-shaped: no `sk_` / `rk_` prefix, so
 * neither a human reading a config dump nor a secret scanner can
 * mistake it for a real key. It authenticates nothing — Stripe answers
 * any request bearing it with a 401.
 */
export const INBOUND_ONLY_SENTINEL_API_KEY = 'unusable-key:service-webhook-is-inbound-only';

/**
 * Builds the single `Stripe` instance this pod uses.
 *
 * **Why there is no real API key.** `service-webhook` is an
 * *inbound-only* surface (TS-041a): it receives Stripe's POSTs and
 * verifies them with `stripe.webhooks.constructEvent`, which
 * authenticates against `STRIPE_WEBHOOK_SECRET` — a different
 * credential, with a different lifecycle and a different blast radius
 * than the secret key (CLAUDE.md §3.5). Nothing in this service calls a
 * Stripe API endpoint. Adding `STRIPE_SECRET_KEY` to this pod's
 * environment would hand full account-API authority to a process that
 * has no use for it, purely to satisfy a constructor.
 *
 * **Why not an empty string.** The original wiring passed `''` on the
 * documented belief that the SDK tolerates it and fails only on an
 * actual outbound call. That is not true of `stripe@17.4.0`: the
 * *constructor* throws `Neither apiKey nor config.authenticator
 * provided`, so the service could never boot at all (TS-508).
 *
 * **Why not `config.authenticator`.** The SDK's documented alternative
 * to an `apiKey` is an `authenticator`, and one that refuses every
 * request looks like the ideal fail-loud seam — it would stop an
 * accidental call locally, before any bytes reached Stripe. It is
 * unusable at this version. `RequestSender._request` calls
 * `authenticator(request).then(...).catch((e) => { throw new
 * StripeError(...) })`: the rejection is re-thrown inside a promise
 * chain nobody awaits, `callback` is never invoked, and so the
 * *caller's* promise never settles. An accidental outbound call would
 * hang forever (against CLAUDE.md §5.2) and surface only as an
 * unhandled rejection — which, under Node's default, kills a pod that
 * is serving live webhooks. Revisit if the SDK fixes this.
 *
 * **What we do instead.** We construct with
 * {@link INBOUND_ONLY_SENTINEL_API_KEY}. This keeps every property we
 * need:
 *
 * - the constructor succeeds, so the pod boots;
 * - `webhooks.constructEvent` does not consult the API key, so
 *   signature verification is untouched;
 * - an outbound call fails loudly *and cleanly* — Stripe answers 401
 *   and the SDK rejects the caller's promise with a
 *   `StripeAuthenticationError`, which no `catch` can mistake for a
 *   business outcome;
 * - and the pod holds no usable Stripe credential, so the failure
 *   cannot degrade into a *successful* unintended API call.
 *
 * The residual trade-off, stated plainly: an accidental call does leave
 * the pod carrying whatever payload the caller passed. That is the cost
 * of not hanging the request, and it is bounded — there are no outbound
 * call sites in this service, and the first one added fails its very
 * first run.
 *
 * If a future task genuinely needs an outbound call from here, the fix
 * is to add `STRIPE_SECRET_KEY` to the env schema and pass it in place
 * of the sentinel — not to widen this service's remit quietly.
 *
 * `apiVersion` is pinned from env so the SDK's request shape matches
 * the one the webhook endpoint is configured against in the Stripe
 * Dashboard. Unpinned, the SDK uses whatever default ships with its
 * current minor version, which would silently shift the structured
 * event payload on a library upgrade.
 */
export const createInboundOnlyStripeClient = (env: Env): Stripe =>
  new Stripe(INBOUND_ONLY_SENTINEL_API_KEY, {
    ...(env.STRIPE_API_VERSION !== undefined && {
      apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
    }),
  });
