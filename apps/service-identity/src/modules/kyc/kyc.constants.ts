/**
 * KYC-module shared constants.
 *
 * `STRIPE_SDK_TOKEN` — DI token for the (mockable) Stripe SDK instance
 * used by `StripeIdentityClient`. Symbol-based DI so unit tests can bind
 * a mock to the same token cleanly (avoids the `vi.mocked(Stripe)`
 * global-mock pattern). Mirrors the shape used by service-subscription
 * and service-webhook — each service owns its own DI token because the
 * Stripe SDK instance is constructed per pod and not shared via a
 * cross-service module.
 *
 * `KYC_DISPATCH_HEADER_NAME` — the HTTP header carrying the shared
 * secret on the internal webhook-dispatch route. service-webhook sets
 * this header; the route's `KycInternalDispatchGuard` reads it.
 *
 * `KYC_DISPATCH_PATH` — the URL path for the internal dispatch endpoint.
 * Constant so the same string is used by the route decorator and the
 * test boundary; service-webhook composes its dispatch URL by
 * concatenating `STRIPE_IDENTITY_DISPATCH_URL` (the base + path).
 */
export const STRIPE_SDK_TOKEN = Symbol.for('@taste-and-see/service-identity:stripe-sdk');
export const KYC_DISPATCH_HEADER_NAME = 'x-kyc-internal-api-key';
export const KYC_DISPATCH_PATH = 'api/v1/internal/kyc/webhook-events';
