import {
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
  type SubscriptionDunningExhausted,
  type SubscriptionPaymentFailed,
  type SubscriptionPaymentSucceeded,
} from '@taste-and-see/contracts';

/**
 * Rung selection + template-variable construction for the dunning ladder
 * (TS-042-followup-3a2). Pure: no IO, no clock, no DI — everything here is
 * a function of the event plus two configured strings.
 *
 * Kept out of the service because these are the decisions worth pinning in
 * tests, and every one of them has a customer on the other side of it.
 */

/** The two strings the templates need that the event cannot supply. */
export interface DunningTemplateConfig {
  readonly appName: string;
  readonly billingUrl: string;
}

/** A rung to send, or an explicit reason there is nothing to send. */
export type DunningRung =
  | {
      readonly kind: 'send';
      readonly templateCode: string;
      readonly variables: Readonly<Record<string, string | number | boolean>>;
    }
  | { readonly kind: 'skip'; readonly reason: 'routine_renewal' };

/**
 * Human date for a template label, e.g. "May 14, 2026".
 *
 * **UTC, and en-US, both pinned.** The instant comes from Stripe's clock or
 * ours; rendering it in the pod's local zone would give two replicas in
 * different regions two different deadlines for the same event. Phase 1 is
 * en-US only (PRD §11.4) and the template is too, so the formatter matches
 * the template rather than the reader.
 *
 * `Intl` rather than `date-fns` — no dependency, and this is one format.
 */
export function formatTemplateDate(isoInstant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(isoInstant));
}

/**
 * First declined attempt vs a later one.
 *
 * **`attemptCount === 1` is the whole discriminator**, and it selects the
 * rung without ever appearing in the copy — the first failure is reassuring
 * ("we'll try again, nothing changes"), the later ones lead with the
 * deadline. A platform that sent the reassuring one every time would be
 * telling a family on day 19 of a 21-day grace window that there is nothing
 * to do.
 */
export function rungForPaymentFailed(
  event: SubscriptionPaymentFailed,
  config: DunningTemplateConfig,
): DunningRung {
  const hasGraceWindow = event.graceUntil !== null;
  const hasNextAttempt = event.nextAttemptAt !== undefined;

  if (event.attemptCount === 1) {
    return {
      kind: 'send',
      templateCode: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
      variables: {
        appName: config.appName,
        billingUrl: config.billingUrl,
        hasGraceWindow,
        // Empty string, never a placeholder date. The template's `{{#if}}`
        // decides display; the value exists only so the renderer's
        // all-or-nothing variable validation passes.
        graceUntilLabel: event.graceUntil === null ? '' : formatTemplateDate(event.graceUntil),
        hasNextAttempt,
        nextAttemptLabel:
          event.nextAttemptAt === undefined ? '' : formatTemplateDate(event.nextAttemptAt),
      },
    };
  }

  return {
    kind: 'send',
    templateCode: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
    variables: {
      appName: config.appName,
      billingUrl: config.billingUrl,
      hasGraceWindow,
      graceUntilLabel: event.graceUntil === null ? '' : formatTemplateDate(event.graceUntil),
    },
  };
}

/**
 * Recovery — or silence.
 *
 * **`recovered === false` sends NOTHING.** A routine monthly renewal and a
 * payment that rescued a `past_due` subscription are the same Stripe event;
 * mailing "you're all set" on every renewal tells a family every month that
 * they had a problem they never had. That discriminator exists for exactly
 * this call site (see the `SubscriptionPaymentSucceeded` doc-block), and
 * getting it wrong is the single loudest mistake this ladder can make — it
 * would be a monthly email to every paying customer on the platform.
 */
export function rungForPaymentSucceeded(
  event: SubscriptionPaymentSucceeded,
  config: DunningTemplateConfig,
): DunningRung {
  if (!event.recovered) {
    return { kind: 'skip', reason: 'routine_renewal' };
  }
  return {
    kind: 'send',
    templateCode: BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
    variables: { appName: config.appName, billingUrl: config.billingUrl },
  };
}

/**
 * Grace expired, service paused. Always sends — this is the one rung that
 * reports a consequence the family has not been told about anywhere else.
 *
 * Carries no grace variables on purpose: the window has already closed, and
 * restating the date it closed reads as a reprimand rather than a fact.
 */
export function rungForDunningExhausted(
  _event: SubscriptionDunningExhausted,
  config: DunningTemplateConfig,
): DunningRung {
  return {
    kind: 'send',
    templateCode: BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
    variables: { appName: config.appName, billingUrl: config.billingUrl },
  };
}

/**
 * Dispatch idempotency key for one recipient of one event.
 *
 * **Keyed on `(eventId, recipientUserId)` and NOT on the event alone.** One
 * event fans out to every payer in the household, so an event-only key would
 * let the first payer's dispatch suppress the second's. The dispatch table's
 * `idempotency_key` UNIQUE is the DOMAIN guard behind the consumer SDK's
 * dedup table: a redelivery that slips past the ledger still replays here
 * rather than sending a second email.
 */
export function dunningIdempotencyKey(eventId: string, recipientUserId: string): string {
  return `dunning:${eventId}:${recipientUserId}`;
}
