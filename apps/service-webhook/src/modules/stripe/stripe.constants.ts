/**
 * Stripe-module shared constants.
 *
 * Kept in their own module so `main.ts` (the raw-body parser wiring) and
 * `stripe-webhook.controller.ts` (the @Controller path) reference the
 * *same* path without circular imports. If they drift, the controller
 * registers a route Express has no raw parser for, and signature
 * verification fails silently (a 400 the controller can't explain).
 *
 * `STRIPE_WEBHOOK_PATH` — the absolute URL path Stripe POSTs to. Public
 * by design: the path itself is not a secret; the signature is the gate.
 * The path is documented in the Stripe Dashboard endpoint config and in
 * the local `stripe listen --forward-to ...` runbook command.
 *
 * `STRIPE_SDK_TOKEN` — DI token for the (mockable) Stripe SDK instance.
 * Avoids `@nestjs/common`'s `provide: 'STRIPE_SDK'` magic-string pattern.
 */
export const STRIPE_WEBHOOK_PATH = '/api/v1/webhooks/stripe';
export const STRIPE_SDK_TOKEN = Symbol.for('@taste-and-see/service-webhook:stripe-sdk');
