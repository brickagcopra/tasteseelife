import type { NotificationCategory } from './notification-dispatch.schema';
import type {
  NotificationChannelKind,
  NotificationLocale,
  NotificationVariableEntry,
} from './notification.schema';

/**
 * Template identity + variable contracts for the billing / dunning email
 * ladder (TS-042-followup-3a3; PRD §10.3; CLAUDE.md §12; PDD §12.2).
 *
 * Four templates, one per moment a family can be in. They exist here — not
 * in service-notification — because PDD §12.2 mandates that template
 * variables are "strictly typed via shared contract package": the
 * service-notification seed declares EXACTLY these variables and the
 * TS-042-followup-3a2 outbox consumer supplies EXACTLY these variables. The
 * render endpoint rejects a dispatch that omits a required variable or
 * sends an unknown one, so the two sides MUST agree — these constants are
 * the single source they both import. The MJML/subject copy stays in the
 * seed (presentation detail, service-notification-local).
 *
 * ## Why four codes and not one with a mode flag
 *
 * A template version is immutable and versioned per `code_locale`. Folding
 * four different customer moments into one template makes every copy edit
 * to the "we couldn't reach your card" wording mint a new version of the
 * "thank you, you're all set" email too, and makes the subject line a
 * Handlebars conditional — subject lines are the part of a dunning ladder
 * most likely to be tuned independently.
 *
 * ## Which event drives which template
 *
 * | Template                        | Event                             | Discriminator          |
 * |---------------------------------|-----------------------------------|------------------------|
 * | `billing-payment-failed-first`  | `subscription.payment_failed`     | `attemptCount === 1`   |
 * | `billing-payment-failed-retry`  | `subscription.payment_failed`     | `attemptCount > 1`     |
 * | `billing-payment-recovered`     | `subscription.payment_succeeded`  | `recovered === true`   |
 * | `billing-service-paused`        | `subscription.dunning_exhausted`  | (the event itself)     |
 *
 * `recovered === false` is a routine renewal and mails NOBODY — see the
 * `SubscriptionPaymentSucceeded` doc-block.
 *
 * ## What the copy may NOT say
 *
 * 1. **No amount.** `subscription.payment_failed` carries no invoice total
 *    by design (the producer is driven by `stripe.invoice.changed`, which
 *    carries handles only). A template that promised "$X is due" would have
 *    to invent the figure from the plan price, which disagrees with the
 *    invoice whenever a proration or coupon applies. No variable here
 *    carries money, so the copy cannot state one.
 * 2. **No attempt count.** The event has `attemptCount` and it selects the
 *    template, but "this is our 3rd attempt" is collections framing. A
 *    family whose card expired is not a delinquent account (CLAUDE.md §12).
 * 3. **No card-update promise.** This platform has NO customer-facing
 *    payment-method update surface today — `apps/web-family` ships
 *    `/billing/invoices` (read-only) and nothing else, and payment methods
 *    are readable only through the admin subscription detail. `billingUrl`
 *    therefore points at the billing surface that exists and the copy says
 *    "review", never "update your card here". See
 *    TS-042-followup-3a3-followup-1.
 * 4. **No senior's name, no recipient name.** The resolver chain
 *    (TS-042-followup-3a1 household payers → identity recipient-contacts)
 *    yields user ids and email addresses, and nothing else. Declaring a
 *    `payerName` the consumer cannot fill is how a required variable
 *    becomes a render-time 400 in production. The greeting is unnamed, as
 *    the wellness-summary template's already is.
 *
 * ## Optional event fields become a boolean gate, not an optional variable
 *
 * `graceUntil` is nullable and `nextAttemptAt` is optional on the event.
 * The renderer's variable validation is all-or-nothing per declared
 * variable, so each pair ships as a REQUIRED boolean gate plus a REQUIRED
 * string that is empty when the gate is false — the same shape the
 * wellness-summary template uses for `detailShared`. Without the gate the
 * template renders "we'll try again on ." to a family.
 */

// ─── Shared identity ────────────────────────────────────────────────────

/** Phase-1 locale for the whole ladder (PRD §11.4 ships en-US first). */
export const DUNNING_TEMPLATE_LOCALE: NotificationLocale = 'en-US';

/** Every rung of the ladder is email. SMS/push are TS-073-followup-2/-3. */
export const DUNNING_TEMPLATE_CHANNEL: NotificationChannelKind = 'email';

/**
 * Transactional, not marketing. A notice that the payment for a household's
 * care did not go through is a service communication about an account the
 * family opened — it defaults opt-in and is not gated by the marketing
 * opt-out (TCPA / CAN-SPAM). It still honours quiet hours unless the caller
 * bypasses: a 3am "your card was declined" is not an emergency.
 */
export const DUNNING_TEMPLATE_CATEGORY: NotificationCategory = 'transactional';

// ─── Template codes ─────────────────────────────────────────────────────

/** First declined attempt on a subscription (`attemptCount === 1`). */
export const BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE = 'billing-payment-failed-first';

/** A subsequent declined attempt — same subscription, still unresolved. */
export const BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE = 'billing-payment-failed-retry';

/** A payment that cleared a `past_due` / `unpaid` subscription. */
export const BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE = 'billing-payment-recovered';

/** The grace window expired and service moved to `unpaid`. */
export const BILLING_SERVICE_PAUSED_TEMPLATE_CODE = 'billing-service-paused';

/** Every code in the ladder, for seed + consumer iteration and tests. */
export const BILLING_DUNNING_TEMPLATE_CODES = [
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
] as const;
export type BillingDunningTemplateCode = (typeof BILLING_DUNNING_TEMPLATE_CODES)[number];

// ─── Shared variable entries ────────────────────────────────────────────

/**
 * The entries reused across rungs, declared once so their descriptions
 * cannot drift between templates. Each template below picks the subset it
 * actually renders — a template must not declare a variable it never uses
 * (the seed test asserts this), because a required-but-unrendered variable
 * is a dispatch the consumer must populate for no reason.
 */
const APP_NAME_VARIABLE: NotificationVariableEntry = {
  name: 'appName',
  type: 'string',
  required: true,
  description: 'Product name for the header and footer, e.g. "Taste & See".',
};

const BILLING_URL_VARIABLE: NotificationVariableEntry = {
  name: 'billingUrl',
  type: 'string',
  required: true,
  description:
    'Where the family manages their billing — web-family `/billing`, which opens a Stripe Billing Portal session (TS-042-followup-3a3-followup-1). It pointed at the read-only invoice list until that shipped, which is why the copy said "review your billing details" and never "update your card"; both changed together. Must match service-subscription’s BILLING_PORTAL_RETURN_URL.',
};

const HAS_GRACE_WINDOW_VARIABLE: NotificationVariableEntry = {
  name: 'hasGraceWindow',
  type: 'boolean',
  required: true,
  description:
    'Whether a grace deadline could be established. False when the event carried a null `graceUntil` — the deadline block is then omitted rather than rendered empty.',
};

const GRACE_UNTIL_LABEL_VARIABLE: NotificationVariableEntry = {
  name: 'graceUntilLabel',
  type: 'string',
  required: true,
  description:
    'Human date the grace window closes, e.g. "May 14, 2026". Empty string when `hasGraceWindow` is false.',
};

// ─── Per-template variable sets ─────────────────────────────────────────

/**
 * First failure. The warmest rung: the card simply did not go through, it
 * will be tried again automatically, and nothing has changed about the
 * care. `hasNextAttempt` / `nextAttemptLabel` exist only here — the
 * reassurance that a retry is coming is what makes this rung different
 * from the next one, and by the time we escalate the retry is no longer
 * the news.
 */
export const BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] =
  [
    APP_NAME_VARIABLE,
    BILLING_URL_VARIABLE,
    HAS_GRACE_WINDOW_VARIABLE,
    GRACE_UNTIL_LABEL_VARIABLE,
    {
      name: 'hasNextAttempt',
      type: 'boolean',
      required: true,
      description:
        "Whether Stripe's next retry instant is known. False when the event omitted `nextAttemptAt`.",
    },
    {
      name: 'nextAttemptLabel',
      type: 'string',
      required: true,
      description:
        'Human date of the next automatic attempt, e.g. "May 3, 2026". Empty string when `hasNextAttempt` is false.',
    },
  ];

export const BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES = [
  'appName',
  'billingUrl',
  'hasGraceWindow',
  'graceUntilLabel',
  'hasNextAttempt',
  'nextAttemptLabel',
] as const;

/**
 * Escalation. Same facts, firmer frame: the payment still has not gone
 * through and the deadline is the news. Deliberately carries NO attempt
 * count — the number selects this template, it does not appear in it.
 */
export const BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] =
  [APP_NAME_VARIABLE, BILLING_URL_VARIABLE, HAS_GRACE_WINDOW_VARIABLE, GRACE_UNTIL_LABEL_VARIABLE];

export const BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES = [
  'appName',
  'billingUrl',
  'hasGraceWindow',
  'graceUntilLabel',
] as const;

/**
 * Recovered. Sent ONLY when `recovered === true`. Two variables: there is
 * nothing to explain, and a long "here's what happened" recap of a problem
 * that is now over is itself the problem.
 */
export const BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] = [
  APP_NAME_VARIABLE,
  BILLING_URL_VARIABLE,
];

export const BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES = ['appName', 'billingUrl'] as const;

/**
 * Service paused. The one rung that reports a consequence, so it is the
 * one that must be clearest that the consequence is reversible. No grace
 * variables — the window has already closed, and restating the date it
 * closed reads as a reprimand.
 */
export const BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] = [
  APP_NAME_VARIABLE,
  BILLING_URL_VARIABLE,
];

export const BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES = ['appName', 'billingUrl'] as const;

export type BillingPaymentFailedFirstTemplateVariableName =
  (typeof BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLE_NAMES)[number];
export type BillingPaymentFailedRetryTemplateVariableName =
  (typeof BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLE_NAMES)[number];
export type BillingPaymentRecoveredTemplateVariableName =
  (typeof BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLE_NAMES)[number];
export type BillingServicePausedTemplateVariableName =
  (typeof BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLE_NAMES)[number];
