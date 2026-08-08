import type { NotificationCategory } from './notification-dispatch.schema';
import type {
  NotificationChannelKind,
  NotificationLocale,
  NotificationVariableEntry,
} from './notification.schema';

/**
 * Template identity + variable contract for the account email-verification
 * message (TS-510-followup-4; PDD §12.2; CLAUDE.md §3.1, §5.3).
 *
 * **The message nobody was sending.** `service-identity` has minted
 * verification tokens and emitted `identity.email_verification_requested`
 * since TS-510, and the outbox relay has drained that table all along —
 * but nothing consumed the event, so no verification email was ever
 * physically sent. The feature was testable end to end and unusable by a
 * real person. This is the template that consumer renders.
 *
 * As with the dunning ladder, the constants live in contracts rather than
 * in service-notification because the seed declares exactly these
 * variables and the consumer supplies exactly these variables; the render
 * endpoint rejects a dispatch that omits a required one or sends an
 * unknown one, so both sides must import the same source of truth. The
 * copy itself stays in the seed.
 *
 * ## One template, two reasons — and why that is the right split
 *
 * `identity.email_verification_requested` carries `reason: 'signup' |
 * 'resend'`, and the difference is one sentence of framing ("welcome" vs
 * "here's that link again"), not a different message. A `isResend`
 * boolean inside one template keeps the link, the expiry line and the
 * did-not-request footer in a single place — which matters because those
 * are the parts that must never drift. The dunning ladder split into four
 * codes for the opposite reason: there the four moments differ in subject
 * line, tone and call to action all at once.
 *
 * ## What the copy may NOT do
 *
 * 1. **No token in the log, ever — and the rendered body IS the token.**
 *    The link contains a live single-use bearer secret, so the consumer
 *    must not log the payload and the dispatch record must not carry the
 *    rendered body (CLAUDE.md §3.1).
 * 2. **No name.** The event carries a userId and an address and nothing
 *    else; resolving a name would mean reading `identity.users` across a
 *    service boundary (§17.3). The greeting is unnamed, as the dunning and
 *    wellness templates already are.
 * 3. **No claim that the account is unusable until verified.** Whether an
 *    unverified account is restricted is a product decision this platform
 *    has not made, and a template that asserted it would be the place the
 *    decision got made by accident.
 */

/** Email only — a verification link is not an SMS or a push. */
export const ACCOUNT_VERIFICATION_TEMPLATE_CHANNEL: NotificationChannelKind = 'email';

/** Phase 1 is `en-US` only, as with every other seeded template. */
export const ACCOUNT_VERIFICATION_TEMPLATE_LOCALE: NotificationLocale = 'en-US';

/**
 * Transactional beyond argument: the recipient asked for this seconds ago
 * by typing the address into a signup form. It is also the one message on
 * the platform that legitimately **bypasses quiet hours** — a person
 * sitting at a signup form at 11pm is waiting for it, and holding it until
 * morning breaks the flow they are in the middle of.
 */
export const ACCOUNT_VERIFICATION_TEMPLATE_CATEGORY: NotificationCategory = 'transactional';

/** The single template code. */
export const ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE = 'account-email-verification';

export const ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_VARIABLES: readonly NotificationVariableEntry[] = [
  {
    name: 'appName',
    type: 'string',
    required: true,
    description: 'Product name for the header and footer, e.g. "Taste & See".',
  },
  {
    name: 'verificationUrl',
    type: 'string',
    required: true,
    description:
      'The absolute confirmation URL, token included. A LIVE SINGLE-USE CREDENTIAL: never log it, never store the rendered body, never include it in an error message. Built by the consumer from EMAIL_VERIFICATION_URL_BASE + the token on the event.',
  },
  {
    name: 'expiresInLabel',
    type: 'string',
    required: true,
    description:
      'How long the link lasts, phrased for a reader, e.g. "24 hours". Derived from the event’s `expiresAt` relative to `occurredAt` — never a raw timestamp, which invites a reader to compare it against a clock in the wrong time zone.',
  },
  {
    name: 'isResend',
    type: 'boolean',
    required: true,
    description:
      'True when the event’s `reason` is `resend`. Switches the opening line from a welcome to "here’s that link again" — the ONLY difference between the two cases. Required rather than optional so a consumer cannot omit it and silently get the welcome copy on a resend.',
  },
];
