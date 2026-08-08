import {
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLES,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
  BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLES,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
  BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLES,
  BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
  BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLES,
  DUNNING_TEMPLATE_CHANNEL,
} from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import { MjmlCompilerService } from '../services/mjml-compiler.service';

import {
  DB_LOCALE_EN_US,
  seedNotificationTemplate,
  type NotificationTemplateSeedDefinition,
  type NotificationTemplateSeedReport,
} from './notification-template-seed';

/**
 * Seeds for the billing / dunning email ladder (TS-042-followup-3a3;
 * PRD §10.3; CLAUDE.md §12; PDD §12.2).
 *
 * Four templates, one per moment a family can be in — first declined
 * attempt, a later one, recovery, and a paused membership. The
 * TS-042-followup-3a2 outbox consumer picks the rung from the event (see
 * the table in `dunning-notifications.schema.ts`); the render path 404s if
 * no active version exists, so these MUST be seeded before that consumer
 * can send anything.
 *
 * **The copy is the deliverable here.** A family whose card expired is not
 * a delinquent account, and this is very often a household under strain
 * already — someone's parent is receiving care. So, deliberately:
 *
 * - **No amount, ever.** The event carries no invoice total by design (see
 *   the `SubscriptionPaymentFailed` doc-block); the templates therefore
 *   declare no money variable and cannot state a figure. The billing
 *   surface is the source of truth and the link goes there.
 * - **No attempt count.** `attemptCount` selects the rung; it never appears
 *   in the copy. "This is our 3rd attempt" is a collections notice.
 * - **The call to action names the fix, and only where there IS one.**
 *   Until TS-042-followup-3a3-followup-1 this copy could not say "update
 *   your card": `{{billingUrl}}` pointed at a read-only invoice list, so
 *   the templates said "review your billing details" and a test enforced
 *   the absence. `{{billingUrl}}` now points at `/billing`, which opens a
 *   Stripe Billing Portal session, so the three rungs that need action say
 *   so plainly — and the RECOVERED rung deliberately still does not, since
 *   telling someone to fix a payment that just succeeded reads as a second
 *   failure. **`DUNNING_BILLING_URL` must point at `/billing`, not
 *   `/billing/invoices`** — this copy and that env var move together.
 * - **No named recipient.** The resolver chain yields user ids and email
 *   addresses only, so the greeting is unnamed — as the wellness-summary
 *   template's already is.
 * - **A reversible consequence is stated as reversible.** The pause email
 *   leads with the pause and then says, in the next breath, that the
 *   schedule picks up where it left off. Fear does not make a card work.
 *
 * **Single source of truth for variables.** The declared variable schemas
 * come from `@taste-and-see/contracts`, the SAME constants the consumer
 * reads to build its dispatch payload — so the seed and the consumer cannot
 * drift (PDD §12.2).
 */

const DB_LOCALE = DB_LOCALE_EN_US; // contract 'en-US' → Postgres enum value
const DB_KIND = DUNNING_TEMPLATE_CHANNEL; // 'email' — same token in both layers

/** Shared MJML chrome. Identical to the wellness-summary / renewal shells. */
function wrapMjml(inner: string): string {
  return `<mjml>
  <mj-body background-color="#f7f3ed">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text font-size="22px" font-family="Georgia, 'Times New Roman', serif" color="#3b2f2a" align="center">
          {{appName}}
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" border-radius="12px" padding="24px">
      <mj-column>
${inner}
        <mj-divider border-color="#e7ded3" border-width="1px" padding="12px 0" />
        <mj-text font-size="13px" font-family="Helvetica, Arial, sans-serif" color="#8a7d73" line-height="1.6">
          With warmth,<br/>
          The {{appName}} team
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

const GREETING_BLOCK = `        <mj-text font-size="18px" font-family="Helvetica, Arial, sans-serif" color="#3b2f2a">
          Hello,
        </mj-text>`;

/** Body-copy paragraph in the shared type scale. */
function paragraph(text: string): string {
  return `        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.6">
${text}
        </mj-text>`;
}

function billingButton(label: string): string {
  return `        <mj-button background-color="#7a5c3e" color="#ffffff" border-radius="8px" font-family="Helvetica, Arial, sans-serif" font-size="15px" padding="16px 0" href="{{billingUrl}}">
          ${label}
        </mj-button>`;
}

/**
 * The call to action for the three rungs that need the family to DO
 * something (TS-042-followup-3a3-followup-1). Until the Billing Portal
 * landed, `{{billingUrl}}` pointed at a read-only invoice list and this
 * button could only say "review" — the platform asked a family to fix a
 * payment and then showed them a receipt. It now points at
 * `/billing`, where a card can actually be changed, so the button says
 * what it does.
 */
const UPDATE_CARD_BUTTON_BLOCK = billingButton('Update your card');

/**
 * The recovered rung's button. There is nothing to fix, so it must not
 * imply there is — an "update your card" button on a message telling
 * someone their payment went through reads as a second failure.
 */
const BILLING_BUTTON_BLOCK = billingButton('View billing details');

// ─── 1. First declined attempt ──────────────────────────────────────────

const FIRST_SUBJECT = 'A quick note about your {{appName}} payment';

const FIRST_MJML = wrapMjml(
  [
    GREETING_BLOCK,
    paragraph(
      `          We weren't able to complete the payment for your {{appName}} membership. It happens more often
          than you'd think &mdash; a card expires, or a bank pauses a routine charge.`,
    ),
    `        {{#if hasNextAttempt}}
${paragraph(
  `          We'll try again automatically on {{nextAttemptLabel}}, so there may well be nothing for you to do.`,
)}
        {{else}}
${paragraph(
  `          We'll try again automatically over the next few days, so there may well be nothing for you to do.`,
)}
        {{/if}}`,
    `        {{#if hasGraceWindow}}
${paragraph(
  `          If it still hasn't gone through by {{graceUntilLabel}}, we'll need to pause upcoming visits until it
          does &mdash; and we would much rather not.`,
)}
        {{/if}}`,
    paragraph(`          Nothing changes in the meantime: visits carry on exactly as scheduled.`),
    UPDATE_CARD_BUTTON_BLOCK,
  ].join('\n'),
);

const FIRST_TEXT = `Hello,

We weren't able to complete the payment for your {{appName}} membership. It happens more often than you'd think - a card expires, or a bank pauses a routine charge.
{{#if hasNextAttempt}}
We'll try again automatically on {{nextAttemptLabel}}, so there may well be nothing for you to do.
{{else}}
We'll try again automatically over the next few days, so there may well be nothing for you to do.
{{/if}}
{{#if hasGraceWindow}}
If it still hasn't gone through by {{graceUntilLabel}}, we'll need to pause upcoming visits until it does - and we would much rather not.
{{/if}}
Nothing changes in the meantime: visits carry on exactly as scheduled.

You can update your card here, if it needs it: {{billingUrl}}

With warmth,
The {{appName}} team`;

// ─── 2. A later declined attempt ────────────────────────────────────────

const RETRY_SUBJECT = "Your {{appName}} payment still hasn't gone through";

const RETRY_MJML = wrapMjml(
  [
    GREETING_BLOCK,
    paragraph(
      `          We've tried again, and the payment for your {{appName}} membership still hasn't come through.`,
    ),
    `        {{#if hasGraceWindow}}
${paragraph(
  `          To keep upcoming visits on the calendar, it needs to be sorted by {{graceUntilLabel}}.`,
)}
        {{else}}
${paragraph(`          We'd like to get this resolved before it affects anything on the calendar.`)}
        {{/if}}`,
    paragraph(
      `          Updating your card takes about a minute, and it's the quickest way to put it right.`,
    ),
    UPDATE_CARD_BUTTON_BLOCK,
    paragraph(
      `          And if something has changed for your family, we would far rather work it out with you than
          interrupt anyone's care.`,
    ),
  ].join('\n'),
);

const RETRY_TEXT = `Hello,

We've tried again, and the payment for your {{appName}} membership still hasn't come through.
{{#if hasGraceWindow}}
To keep upcoming visits on the calendar, it needs to be sorted by {{graceUntilLabel}}.
{{else}}
We'd like to get this resolved before it affects anything on the calendar.
{{/if}}
Updating your card takes about a minute: {{billingUrl}}

And if something has changed for your family, we would far rather work it out with you than interrupt anyone's care.

With warmth,
The {{appName}} team`;

// ─── 3. Recovered ───────────────────────────────────────────────────────

// Literal em-dash, not `&mdash;` — a subject line is plain text and an
// HTML entity would reach the inbox verbatim.
const RECOVERED_SUBJECT = "You're all set — thank you";

const RECOVERED_MJML = wrapMjml(
  [
    GREETING_BLOCK,
    paragraph(
      `          Your payment came through. Everything on your {{appName}} membership is back to normal, and
          there is nothing further for you to do.`,
    ),
    paragraph(`          Thank you for taking care of it.`),
    BILLING_BUTTON_BLOCK,
  ].join('\n'),
);

const RECOVERED_TEXT = `Hello,

Your payment came through. Everything on your {{appName}} membership is back to normal, and there is nothing further for you to do.

Thank you for taking care of it.

Your billing details, any time you'd like them: {{billingUrl}}

With warmth,
The {{appName}} team`;

// ─── 4. Membership paused ───────────────────────────────────────────────

const PAUSED_SUBJECT = "We've paused your {{appName}} membership";

const PAUSED_MJML = wrapMjml(
  [
    GREETING_BLOCK,
    paragraph(
      `          We weren't able to complete payment for your {{appName}} membership, so we've paused it for now.
          Upcoming visits are on hold.`,
    ),
    paragraph(
      `          <strong>This is reversible.</strong> As soon as the payment goes through, your membership and
          your schedule pick up where they left off.`,
    ),
    UPDATE_CARD_BUTTON_BLOCK,
    paragraph(
      `          If circumstances have changed for your family, we would like to help rather than simply switch
          things off.`,
    ),
  ].join('\n'),
);

const PAUSED_TEXT = `Hello,

We weren't able to complete payment for your {{appName}} membership, so we've paused it for now. Upcoming visits are on hold.

This is reversible. As soon as the payment goes through, your membership and your schedule pick up where they left off.

Update your card here and we'll pick straight back up: {{billingUrl}}

If circumstances have changed for your family, we would like to help rather than simply switch things off.

With warmth,
The {{appName}} team`;

// ─── Definitions ────────────────────────────────────────────────────────

export function buildBillingPaymentFailedFirstTemplateSeed(): NotificationTemplateSeedDefinition {
  return {
    code: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Billing — first payment failure',
    description:
      "Sent to a household's billing contacts on the first declined payment attempt for their subscription. Reassuring: the retry is automatic and care is unaffected (TS-042-followup-3a3).",
    subject: FIRST_SUBJECT,
    bodyMjml: FIRST_MJML,
    bodyText: FIRST_TEXT,
    variablesSchema: BILLING_PAYMENT_FAILED_FIRST_TEMPLATE_VARIABLES,
    changeSummary: 'TS-042-followup-3a3 initial first-payment-failure template seed.',
  };
}

export function buildBillingPaymentFailedRetryTemplateSeed(): NotificationTemplateSeedDefinition {
  return {
    code: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Billing — payment still unresolved',
    description:
      "Sent to a household's billing contacts on a subsequent declined attempt, while the grace window is still open. Leads with the deadline, never with the attempt count (TS-042-followup-3a3).",
    subject: RETRY_SUBJECT,
    bodyMjml: RETRY_MJML,
    bodyText: RETRY_TEXT,
    variablesSchema: BILLING_PAYMENT_FAILED_RETRY_TEMPLATE_VARIABLES,
    changeSummary: 'TS-042-followup-3a3 initial payment-still-unresolved template seed.',
  };
}

export function buildBillingPaymentRecoveredTemplateSeed(): NotificationTemplateSeedDefinition {
  return {
    code: BILLING_PAYMENT_RECOVERED_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Billing — payment recovered',
    description:
      "Sent to a household's billing contacts when a payment clears a past_due or unpaid subscription. Never sent for a routine renewal — that is what the event's `recovered` discriminator is for (TS-042-followup-3a3).",
    subject: RECOVERED_SUBJECT,
    bodyMjml: RECOVERED_MJML,
    bodyText: RECOVERED_TEXT,
    variablesSchema: BILLING_PAYMENT_RECOVERED_TEMPLATE_VARIABLES,
    changeSummary: 'TS-042-followup-3a3 initial payment-recovered template seed.',
  };
}

export function buildBillingServicePausedTemplateSeed(): NotificationTemplateSeedDefinition {
  return {
    code: BILLING_SERVICE_PAUSED_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Billing — membership paused',
    description:
      "Sent to a household's billing contacts when the grace window expires and the subscription moves to unpaid. States the pause and its reversibility in the same breath (TS-042-followup-3a3).",
    subject: PAUSED_SUBJECT,
    bodyMjml: PAUSED_MJML,
    bodyText: PAUSED_TEXT,
    variablesSchema: BILLING_SERVICE_PAUSED_TEMPLATE_VARIABLES,
    changeSummary: 'TS-042-followup-3a3 initial membership-paused template seed.',
  };
}

/**
 * Every rung's definition, in ladder order. Exported so the seeder, the
 * CLI report, and the tests iterate ONE list — a fifth rung added to this
 * array is seeded and tested without touching either.
 */
export function buildBillingDunningTemplateSeeds(): readonly NotificationTemplateSeedDefinition[] {
  return [
    buildBillingPaymentFailedFirstTemplateSeed(),
    buildBillingPaymentFailedRetryTemplateSeed(),
    buildBillingPaymentRecoveredTemplateSeed(),
    buildBillingServicePausedTemplateSeed(),
  ];
}

/**
 * Idempotently seed all four dunning templates.
 *
 * Sequential, not `Promise.all`: each rung is an independent transaction
 * and a concurrent burst buys nothing on a one-shot CLI, while a serial run
 * gives the operator a readable per-template log line in ladder order.
 */
export async function seedBillingDunningTemplates(
  prisma: PrismaService,
  mjml: MjmlCompilerService,
): Promise<readonly NotificationTemplateSeedReport[]> {
  const reports: NotificationTemplateSeedReport[] = [];
  for (const seed of buildBillingDunningTemplateSeeds()) {
    reports.push(
      await seedNotificationTemplate(prisma, mjml, seed, 'seed-billing-dunning-templates'),
    );
  }
  return reports;
}
