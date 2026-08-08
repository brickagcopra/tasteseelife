/**
 * Checkr-module shared constants.
 *
 * `CHECKR_WEBHOOK_PATH` — the absolute URL path Checkr POSTs to.
 * Public by design (the path itself is not a secret; the signature
 * is the gate). Registered with Checkr in the Dashboard (Developer
 * → Webhooks) and pinned to a raw-body parser in `main.ts` so the
 * verifier sees the byte-exact request body.
 *
 * `CHECKR_SIGNATURE_HEADER` — the case-insensitive HTTP header
 * Checkr signs each webhook with. Format is
 * `t=<unix>,v1=<hex-sha256>` — same Stripe-style shape — so the
 * verifier can extract the timestamp and HMAC separately.
 *
 * `BACKGROUND_CHECK_DISPATCH_HEADER_NAME` — the shared-secret header
 * service-webhook presents when dispatching events to
 * service-provider. Duplicated in service-provider's
 * `applications.constants.ts` (CLAUDE.md §2.3 — cross-service
 * constants are duplicated by design; the contract that binds them
 * is the Zod schema in `packages/contracts`).
 */
export const CHECKR_WEBHOOK_PATH = '/api/v1/webhooks/checkr';
export const CHECKR_SIGNATURE_HEADER = 'x-checkr-signature';
export const BACKGROUND_CHECK_DISPATCH_HEADER_NAME = 'x-background-check-internal-api-key';
