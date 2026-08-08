/**
 * Stripe-module shared constants.
 *
 * `STRIPE_SDK_TOKEN` — DI token for the (mockable) Stripe SDK instance.
 * Symbol-based DI so unit tests can bind a mock to the same token without
 * `vi.mocked(Stripe)` global-mock contortions.
 *
 * `STRIPE_TRIAL_DAYS_MAX` — defensive cap on the trial-days field a client
 * could pass at create time. Stripe enforces 730 days; we cap lower (90)
 * because product policy is "trials are at most a quarter".
 */
export const STRIPE_SDK_TOKEN = Symbol.for('@taste-and-see/service-subscription:stripe-sdk');
export const STRIPE_TRIAL_DAYS_MAX = 90;
