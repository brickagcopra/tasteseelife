import {
  ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE,
  ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_VARIABLES,
  ACCOUNT_VERIFICATION_TEMPLATE_CHANNEL,
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
 * Seed for the account email-verification message (TS-510-followup-4).
 *
 * **The first thing a new customer ever receives from us, and until now it
 * did not exist.** `service-identity` minted the token and emitted the
 * event; nothing consumed it; nobody was mailed. A person could complete
 * signup and simply never hear from the platform again.
 *
 * The copy carries the whole weight of that first impression, so:
 *
 * - **The link is the message.** One button, one URL in the text part, and
 *   nothing competing with it. No plan pitch, no app tour, no second call
 *   to action — a verification email that also sells is a verification
 *   email people skim past.
 * - **The expiry is stated as a duration, not a timestamp.** "This link
 *   works for the next 24 hours" needs no time zone; "expires at
 *   2026-08-03T09:14:22Z" invites a reader to get it wrong.
 * - **A did-not-request line, and it says to ignore the mail rather than
 *   to contact us.** The address is attacker-choosable (anyone can type
 *   someone else's into a signup form), so the honest instruction to an
 *   unexpected recipient is that doing nothing costs them nothing — the
 *   token expires unused. Telling them to "contact support to secure your
 *   account" would manufacture alarm out of a stranger's typo.
 * - **No name, no account details, no claim about what verification
 *   unlocks.** The event carries an address and a userId; anything more
 *   would mean reading `identity.users` across a service boundary
 *   (CLAUDE.md §17.3). And whether an unverified account is restricted is
 *   a product decision nobody has made — a template must not make it by
 *   implication.
 * - **`isResend` changes exactly one paragraph.** A person who pressed
 *   "send it again" already knows what the platform is; greeting them with
 *   a welcome reads as though the first request vanished.
 *
 * **The rendered body contains a live single-use credential.** Everything
 * downstream of here treats it accordingly — the consumer never logs the
 * payload, and no log line on the path carries the URL (CLAUDE.md §3.1).
 */

const DB_LOCALE = DB_LOCALE_EN_US;
const DB_KIND = ACCOUNT_VERIFICATION_TEMPLATE_CHANNEL;

/** Shared MJML chrome — identical to the dunning / wellness shells. */
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

function paragraph(text: string): string {
  return `        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.6">
${text}
        </mj-text>`;
}

const GREETING_BLOCK = `        <mj-text font-size="18px" font-family="Helvetica, Arial, sans-serif" color="#3b2f2a">
          Hello,
        </mj-text>`;

/**
 * One subject for both cases. A resend that arrives under a different
 * subject line lands in a different place in the inbox from the one the
 * reader is already hunting for.
 */
const SUBJECT = 'Confirm your email for {{appName}}';

const MJML = wrapMjml(
  [
    GREETING_BLOCK,
    `        {{#if isResend}}
${paragraph(`          Here's that link again — one tap and your {{appName}} email is confirmed.`)}
        {{else}}
${paragraph(
  `          Welcome to {{appName}}. One last step: confirm this is your email address, and your
          account is ready.`,
)}
        {{/if}}`,
    `        <mj-button background-color="#7a5c3e" color="#ffffff" border-radius="8px" font-family="Helvetica, Arial, sans-serif" font-size="15px" padding="16px 0" href="{{verificationUrl}}">
          Confirm my email
        </mj-button>`,
    paragraph(
      `          This link works for the next {{expiresInLabel}}. If it runs out, you can ask us for
          a fresh one at any time.`,
    ),
    paragraph(
      `          If you weren't expecting this, you can simply ignore it — the link stops working on
          its own, and nothing happens in the meantime.`,
    ),
  ].join('\n'),
);

const TEXT = `Hello,

{{#if isResend}}
Here's that link again - one tap and your {{appName}} email is confirmed.
{{else}}
Welcome to {{appName}}. One last step: confirm this is your email address, and your account is ready.
{{/if}}

Confirm my email: {{verificationUrl}}

This link works for the next {{expiresInLabel}}. If it runs out, you can ask us for a fresh one at any time.

If you weren't expecting this, you can simply ignore it - the link stops working on its own, and nothing happens in the meantime.

With warmth,
The {{appName}} team`;

export function buildAccountEmailVerificationTemplateSeed(): NotificationTemplateSeedDefinition {
  return {
    code: ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Account — confirm your email',
    description:
      'Sent when a verification token is minted, at signup and on every resend. Carries a live single-use link; the rendered body must never be logged (TS-510-followup-4).',
    subject: SUBJECT,
    bodyMjml: MJML,
    bodyText: TEXT,
    variablesSchema: ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_VARIABLES,
    changeSummary: 'TS-510-followup-4 initial account email-verification template seed.',
  };
}

export async function seedAccountEmailVerificationTemplate(
  prisma: PrismaService,
  mjml: MjmlCompilerService,
): Promise<NotificationTemplateSeedReport> {
  return seedNotificationTemplate(
    prisma,
    mjml,
    buildAccountEmailVerificationTemplateSeed(),
    'seed-account-verification-template',
  );
}
