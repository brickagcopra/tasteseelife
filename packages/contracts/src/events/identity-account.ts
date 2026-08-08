import { z } from 'zod';

/**
 * Identity account-lifecycle events (TS-510).
 *
 * `identity.email_verification_requested` — emitted by `service-identity`
 * whenever a single-use email-verification token is minted: once inside the
 * signup transaction, and again on every explicit resend.
 *
 * **Why an event.** Sending mail is `service-notification`'s bounded context
 * (CLAUDE.md §2.3), and identity must not grow an SMTP client. The producer
 * appends this event to `identity.outbox_events` *inside the same transaction
 * that persists the token hash* (CLAUDE.md §5.3), so a token can never exist
 * without a queued delivery signal and a rolled-back signup mails nobody. The
 * relay already drains `identity.outbox_events`; a new event name on the same
 * table needs no relay-config change. Consumers are idempotent on `eventId`.
 *
 * **This event carries credential material, and that is deliberate.** The
 * `token` field is the bearer secret the recipient clicks. There is no design
 * in which the token does not cross this boundary — the whole point of the
 * event is to deliver it — so rather than obscuring that, the payload names it
 * plainly and the risk is bounded three ways: the token is single-use
 * (`consumed_at` is stamped in the verifying transaction), short-lived
 * (`expiresAt` rides the payload so a consumer can refuse a stale delivery),
 * and stored only as a SHA-256 digest at rest, so a database read cannot mint
 * a working link. Consumers MUST NOT log the payload — the same rule that
 * already applies to a rendered verification email, which necessarily contains
 * the same secret (CLAUDE.md §3.1 "never log raw passwords or full tokens").
 *
 * **`email` is on the payload**, unlike identity's RBAC events which carry ids
 * only. A verification email cannot be addressed without it, and resolving it
 * would mean `service-notification` reading `identity.users` — a cross-service
 * database access CLAUDE.md §17.3 forbids outright. The address is the minimum
 * PII the delivery requires and nothing else about the user travels with it.
 */
export const IDENTITY_EMAIL_VERIFICATION_REQUESTED =
  'identity.email_verification_requested' as const;

/** Soft id cap — `users.id` is CUID-shaped; 64 leaves headroom. */
export const IDENTITY_ACCOUNT_EVENT_ID_MAX_LENGTH = 64;
/** Mirrors `EMAIL_MAX_LENGTH` on the auth HTTP contract. */
export const IDENTITY_ACCOUNT_EVENT_EMAIL_MAX_LENGTH = 320;
/** 32 random bytes rendered base64url is 43 characters; 128 leaves room to grow the token. */
export const IDENTITY_ACCOUNT_EVENT_TOKEN_MAX_LENGTH = 128;

/**
 * Why the token was minted. A consumer renders different copy for a fresh
 * signup than for "you asked us to send that again", and inferring the
 * difference from a count of prior events is not something a consumer that is
 * idempotent on `eventId` can do.
 */
export const IdentityEmailVerificationReasonSchema = z.enum(['signup', 'resend']);
export type IdentityEmailVerificationReason = z.infer<typeof IdentityEmailVerificationReasonSchema>;

export const IdentityEmailVerificationRequestedSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    occurredAt: z.string().datetime(),
    userId: z.string().min(1).max(IDENTITY_ACCOUNT_EVENT_ID_MAX_LENGTH),
    email: z.string().email().max(IDENTITY_ACCOUNT_EVENT_EMAIL_MAX_LENGTH),
    /** The single-use bearer token. See the credential note in the file header. */
    token: z.string().min(1).max(IDENTITY_ACCOUNT_EVENT_TOKEN_MAX_LENGTH),
    expiresAt: z.string().datetime(),
    reason: IdentityEmailVerificationReasonSchema,
  })
  .strict();
export type IdentityEmailVerificationRequested = z.infer<
  typeof IdentityEmailVerificationRequestedSchema
>;
