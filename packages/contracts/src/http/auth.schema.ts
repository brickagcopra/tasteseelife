import { z } from 'zod';

/**
 * Identity / Auth HTTP DTOs (PRD §6.1, PDD §10.1, CLAUDE.md §3.1, §3.3).
 *
 * These are the public contract for `service-identity`'s authentication
 * endpoints. Backend (`apps/service-identity`) and any web client / BFF
 * derive their input validators and response types from this module — the
 * Zod schemas are the single source of truth.
 *
 * `.strict()` everywhere: unknown fields are a parse error so a typo or a
 * stray client field never silently round-trips.
 */

/**
 * Account lifecycle status. Mirrors the `identity.user_status` enum in
 * `apps/service-identity/prisma/schema.prisma` (TS-020 schema).
 *
 * `pending_verification` — signed up; email or phone not yet confirmed.
 * `active`               — normal state; eligible for login.
 * `suspended`            — temporary block by trust & safety / ops.
 * `deactivated`          — permanent close (self-service or admin).
 */
export const UserStatusSchema = z.enum([
  'pending_verification',
  'active',
  'suspended',
  'deactivated',
]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

/**
 * E.164 phone-number pattern. Allows an optional `+`, then 8–15 digits,
 * matching the ITU-T E.164 max-length rule. Looser than full per-country
 * validation (we don't need it here) but tight enough to reject obvious
 * garbage at the boundary.
 */
const E164_PATTERN = /^\+?[1-9]\d{7,14}$/;

/**
 * Email max length. RFC 5321 caps the local-part at 64 octets and the full
 * address (with domain) at 254. We use 254 here.
 */
const EMAIL_MAX_LENGTH = 254;

/**
 * Password length policy at the contract boundary.
 *
 * Minimum: 8 characters — NIST SP 800-63B §5.1.1.2 floor. The platform
 * encourages passphrases via UX (a separate UI concern); the contract floor
 * stays at the standards-compliant minimum so we don't reject longer-but-
 * unusual user choices.
 *
 * Maximum: 64 characters — bcrypt silently truncates inputs longer than
 * 72 bytes, which produces surprising behaviour ("password1234567...A" and
 * "password1234567...B" hash to the same digest). Capping the contract at
 * 64 characters keeps every UTF-8 input well below the 72-byte ceiling
 * (worst case 4 bytes/char × 64 = 256 bytes, but realistic mixed input
 * lands well under 72 bytes; for purely 4-byte-emoji passwords clients
 * will hit the cap). When/if we want to support longer secrets, the fix
 * is server-side SHA-256 pre-hashing before bcrypt — captured as a
 * follow-up if it becomes load-bearing.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/**
 * Signup request (PRD §6.1, CLAUDE.md §3.3).
 *
 * - `email` is normalised to lower-case by the service before storage so
 *   uniqueness is case-insensitive (alice@x.com == ALICE@x.com). The schema
 *   itself is permissive on case so we accept whatever the user typed.
 * - `phone` is optional at signup; when present it must look like an E.164
 *   number. SMS-MFA fallback (TS-023) keys off this column being non-null.
 * - `password` carries only length constraints here. Composition rules
 *   (uppercase, digits, symbols) are intentionally not enforced — NIST
 *   SP 800-63B §5.1.1.2 specifically discourages them. Bcrypt at cost ≥ 12
 *   is the heavy lifting (CLAUDE.md §3.1).
 */
export const SignupRequestSchema = z
  .object({
    email: z
      .string()
      .min(3, 'email is required')
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
      .email('email must be a valid address'),
    phone: z
      .string()
      .regex(E164_PATTERN, 'phone must be in E.164 format (e.g. +14155551212)')
      .optional(),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
      .max(PASSWORD_MAX_LENGTH, `password must be at most ${PASSWORD_MAX_LENGTH} characters`),
  })
  .strict();
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

/**
 * Signup response.
 *
 * Deliberately narrow: the new account's id, normalised email, optional
 * phone, lifecycle status, and creation timestamp. We do NOT return a
 * session token — TS-021 ships signup only; tokens land with TS-022
 * (login + refresh). This avoids the "did the client get logged in or
 * not?" ambiguity and keeps the signup flow a pure resource creation
 * (POST → 201 with the new resource).
 *
 * `passwordHash`, `deletedAt`, and the internal `mfaEnabled` flag are
 * NEVER returned. The user mapper is the only place this gets enforced
 * — never expose raw Prisma rows (CLAUDE.md §3.3).
 */
export const SignupResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    email: z.string().email(),
    phone: z.string().nullable(),
    status: UserStatusSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

/**
 * Login request (PRD §6.1, PDD §10.1, CLAUDE.md §3.1, §17.4).
 *
 * Email + password only. The contract does NOT echo the SignupRequest's
 * length floors and ceilings — the login endpoint should accept any input
 * shape the user could plausibly produce so that mistyped credentials
 * yield a 401 (not a 400 that leaks "your password is the wrong length"
 * as a side-channel about whether the account exists). The bcrypt
 * verification path internally handles the >72-byte truncation surprise
 * by virtue of the same compare-against-stored-digest mechanism that
 * defends signup.
 *
 * `.strict()` still applies — unknown fields are rejected, so a stray
 * `mfaToken` or `rememberMe` from the client is a 400, not a silent
 * pass-through.
 */
export const LoginRequestSchema = z
  .object({
    email: z
      .string()
      .min(1, 'email is required')
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`),
    /**
     * Cap at a generous upper bound that defeats trivial DoS via bcrypt
     * (a few-hundred-MB password would otherwise still hit the server's
     * bcrypt loop). 1024 is well past the 72-byte bcrypt ceiling and any
     * realistic passphrase length.
     */
    password: z.string().min(1, 'password is required').max(1024),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Machine-readable `code` values carried on the RFC 7807 problem body
 * of the admin-staff login gates (TS-023-followup-1, TS-296). Both
 * gates return 403 with `title: 'Forbidden'`; the `code` lets the
 * login UI branch (bounce to the MFA-enrollment surface vs. the
 * SSO-required surface) without regex-matching the human-facing
 * `detail` text. Issued by service-identity's `AuthService`; consumed
 * by `apps/web-admin`'s login action.
 *
 *   - `mfa_enrollment_required` — admin-role holder whose
 *     `users.mfa_enabled` is false (CLAUDE.md §3.1 "MFA mandatory for
 *     all admin staff").
 *   - `sso_assertion_required` — admin-role holder whose org security
 *     policy has `ssoRequired: true` and whose login did not arrive
 *     SSO-asserted (TS-296; the assertion flow itself lands with the
 *     provider-integration sibling task).
 */
export const AUTH_GATE_PROBLEM_CODE = {
  mfaEnrollmentRequired: 'mfa_enrollment_required',
  ssoAssertionRequired: 'sso_assertion_required',
} as const;
export type AuthGateProblemCode =
  (typeof AUTH_GATE_PROBLEM_CODE)[keyof typeof AUTH_GATE_PROBLEM_CODE];

/**
 * Login session response (the `outcome: 'session'` branch of
 * `LoginResponseSchema`). Returned when (a) the user has no MFA
 * configured, or (b) the user just completed an MFA challenge via
 * `/api/v1/auth/mfa/verify` (which mints the same shape).
 *
 * Returns the access token in the JSON body and a minimal `user`
 * object for client convenience (so the SPA can render the user's
 * email after login without an extra `/me` round-trip). The refresh
 * token is NOT in the body — it is set as an HttpOnly cookie by the
 * controller (CLAUDE.md §3.1: "no tokens in localStorage").
 *
 * `expiresIn` is the access-token lifetime in seconds, mirroring
 * OAuth 2.0 convention — clients use it to schedule a proactive
 * refresh before expiry rather than relying on a 401-and-retry loop.
 *
 * `tokenType` is always the literal `"Bearer"` so consumers can
 * blindly concatenate `Authorization: Bearer <token>` without
 * type-narrowing.
 */
export const LoginSessionResponseSchema = z
  .object({
    outcome: z.literal('session'),
    accessToken: z.string().min(1),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
    user: z
      .object({
        id: z.string().min(1).max(64),
        email: z.string().email(),
        status: UserStatusSchema,
      })
      .strict(),
  })
  .strict();
export type LoginSessionResponse = z.infer<typeof LoginSessionResponseSchema>;

/**
 * Login challenge response (the `outcome: 'challenge'` branch of
 * `LoginResponseSchema`). Returned when the credentials are valid
 * AND the user has at least one confirmed MFA method.
 *
 * The body deliberately carries NO user information beyond the
 * challenge token. Disclosing the user's id / email here would let
 * a phisher confirm "yes, this email + password combo is real" even
 * if the second factor blocks the attacker — the challenge response
 * is a "first factor verified" signal that we want to keep narrowly
 * shaped.
 *
 * The `challengeToken` is a short-lived JWT (default 5 min) that
 * the client must echo back to `POST /api/v1/auth/mfa/verify` along
 * with a TOTP code. Single-use enforcement means the same token
 * cannot complete two logins.
 */
export const LoginChallengeResponseSchema = z
  .object({
    outcome: z.literal('challenge'),
    challengeToken: z.string().min(1),
    expiresIn: z.number().int().positive(),
  })
  .strict();
export type LoginChallengeResponse = z.infer<typeof LoginChallengeResponseSchema>;

/**
 * Login response — discriminated union over `outcome`.
 *
 * The discriminator field makes the alternative explicit at the
 * wire so a client cannot accidentally mistake a challenge for a
 * session by inspecting individual field presence (`accessToken`
 * could in principle be added to the challenge branch in a later
 * additive evolution, which would silently break a presence-check
 * narrowing pattern). The string discriminator also reads better in
 * an OpenAPI / Swagger UI than a boolean flag.
 */
export const LoginResponseSchema = z.discriminatedUnion('outcome', [
  LoginSessionResponseSchema,
  LoginChallengeResponseSchema,
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Refresh response.
 *
 * Returns a new access token (and rotates the refresh-token cookie as a
 * side effect on the response). Body is intentionally minimal — clients
 * already have the user object from login; refresh is a token-only
 * exchange. The refresh cookie's value never appears in the body.
 */
export const RefreshResponseSchema = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
  })
  .strict();
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// MFA (TS-023). The TOTP enrollment + verification surface (PDD §10.1,
// CLAUDE.md §3.1). Five endpoint shapes plus one summary type:
//   - MfaEnrollRequest / MfaEnrollResponse — start enrollment
//   - MfaConfirmRequest / MfaConfirmResponse — finish enrollment
//   - MfaVerifyRequest — second-step login challenge → returns
//     LoginSessionResponseSchema (same shape as a no-MFA login)
//   - MfaListResponse + MfaMethodSummary — list / management
//   - MfaRemoveResponse — soft-delete a method
// ─────────────────────────────────────────────────────────────────────

/**
 * MFA method kind, mirroring `identity.mfa_method_kind` Prisma enum.
 * `sms_backup` is reserved for TS-023-followup (Twilio integration
 * lands with TS-073). Including it here now keeps the contract
 * forward-additive — clients that ignore unknown kinds will keep
 * working when SMS arrives.
 */
export const MfaMethodKindSchema = z.enum(['totp', 'sms_backup']);
export type MfaMethodKind = z.infer<typeof MfaMethodKindSchema>;

/**
 * Six-digit numeric TOTP code (RFC 6238 default). The contract
 * enforces exactly six digits so a malformed paste is a 400 at the
 * boundary, not a 401 deeper down. This is fine to reject loudly —
 * the wrong-shape input is not an account-enumeration signal.
 */
const MfaCodeSchema = z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits');

/**
 * MFA enrollment request. `label` is an optional human-readable name
 * for the device ("iPhone Authenticator", "1Password vault"). Capped
 * at 64 chars to prevent UI overflow + log volume.
 */
export const MfaEnrollRequestSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
  })
  .strict();
export type MfaEnrollRequest = z.infer<typeof MfaEnrollRequestSchema>;

/**
 * MFA enrollment response. Carries the `otpauthUrl` (the canonical
 * QR payload) AND the raw `secretBase32` so users with desktop
 * authenticators that don't scan QRs can paste the secret instead.
 *
 * `methodId` is the handle the client echoes back to the confirm
 * endpoint to prove which begun-but-unconfirmed method they're
 * completing — multi-tab enrollments would otherwise race.
 */
export const MfaEnrollResponseSchema = z
  .object({
    methodId: z.string().min(1).max(64),
    secretBase32: z.string().min(1),
    otpauthUrl: z.string().url().startsWith('otpauth://'),
  })
  .strict();
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>;

/**
 * MFA confirmation request — the user types the 6-digit code from
 * their authenticator app and posts it with the methodId returned
 * from enrollment. Successful confirm flips `users.mfaEnabled` to
 * true server-side.
 */
export const MfaConfirmRequestSchema = z
  .object({
    methodId: z.string().min(1).max(64),
    code: MfaCodeSchema,
  })
  .strict();
export type MfaConfirmRequest = z.infer<typeof MfaConfirmRequestSchema>;

/**
 * One-time MFA recovery (backup) code as displayed to the user
 * (TS-023-followup-2). Crockford base32, grouped `XXXXX-XXXXX`. The
 * server stores only a SHA-256 hash; the plaintext appears in exactly
 * one response (`MfaConfirmResponse.recoveryCodes`) and never again.
 * The pattern is intentionally loose on the wire (the server is the
 * authority on format); it documents the shape for client display.
 */
export const MfaRecoveryCodeSchema = z
  .string()
  .regex(/^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/, 'malformed recovery code');
export type MfaRecoveryCode = z.infer<typeof MfaRecoveryCodeSchema>;

/**
 * Confirm response. Acknowledges the enrollment AND returns the freshly
 * minted batch of one-time recovery codes (TS-023-followup-2) — the
 * ONLY moment they are transmitted in plaintext. The client MUST
 * surface them to the user once (download / print / copy) and warn that
 * they will not be shown again; the server keeps only hashes. Without
 * recovery codes a lost authenticator is a support ticket (and a hard
 * lockout for admin staff), so they ship as part of every successful
 * confirm rather than behind a separate opt-in call.
 *
 * The batch is 8–10 codes (the server currently mints 10). We don't
 * echo the method object — clients that need the method record call the
 * list endpoint.
 */
export const MfaConfirmResponseSchema = z
  .object({
    mfaEnabled: z.literal(true),
    recoveryCodes: z.array(MfaRecoveryCodeSchema).min(8).max(10),
  })
  .strict();
export type MfaConfirmResponse = z.infer<typeof MfaConfirmResponseSchema>;

/**
 * MFA verify request — second step of the login flow. The client
 * presents the challenge token from the login response together
 * with a fresh TOTP code; the server consumes the challenge
 * (single-use), verifies the code, and returns a
 * LoginSessionResponse (same shape as a non-MFA login).
 */
export const MfaVerifyRequestSchema = z
  .object({
    challengeToken: z.string().min(1),
    code: MfaCodeSchema,
  })
  .strict();
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/**
 * MFA recovery-verify request (TS-023-followup-2) — the lost-device
 * second step of the login flow. The client presents the same
 * challenge token from the login response together with ONE of the
 * user's recovery codes instead of a TOTP code; the server consumes the
 * challenge (single-use), consumes the recovery code (single-use), and
 * returns a LoginSessionResponse (same shape as a non-MFA login).
 *
 * `recoveryCode` is bounded but deliberately lenient — the server
 * normalises (uppercase, strip separators/spaces) before matching, so
 * a user may paste the dashed display form or type the bare characters.
 * A malformed value renders as the same generic 401 as a wrong code:
 * the recovery-verify failure surface is never an enumeration oracle.
 */
export const MfaRecoveryVerifyRequestSchema = z
  .object({
    challengeToken: z.string().min(1),
    recoveryCode: z.string().min(8).max(64),
  })
  .strict();
export type MfaRecoveryVerifyRequest = z.infer<typeof MfaRecoveryVerifyRequestSchema>;

/**
 * Method summary returned by the list endpoint. Deliberately
 * narrow — no secret material, no key-version metadata, no IP /
 * user-agent telemetry (those live on the audit log surface).
 */
export const MfaMethodSummarySchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: MfaMethodKindSchema,
    label: z.string().nullable(),
    confirmedAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MfaMethodSummary = z.infer<typeof MfaMethodSummarySchema>;

export const MfaListResponseSchema = z
  .object({
    methods: z.array(MfaMethodSummarySchema),
  })
  .strict();
export type MfaListResponse = z.infer<typeof MfaListResponseSchema>;

/**
 * Remove response — minimal acknowledgement. Clients that need to
 * reflect post-removal state call list afterwards.
 */
export const MfaRemoveResponseSchema = z
  .object({
    removed: z.literal(true),
  })
  .strict();
export type MfaRemoveResponse = z.infer<typeof MfaRemoveResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// Email verification (TS-510). Signup creates the account in
// `pending_verification`, and login requires `active` — so until this
// surface existed no account created through the platform's own signup
// could ever log in. Two endpoints close the loop:
//   - POST /api/v1/auth/verify-email          — consume a token, activate
//   - POST /api/v1/auth/verification-emails   — mint and re-deliver one
// ─────────────────────────────────────────────────────────────────────

/**
 * Token length bound. The service mints 32 random bytes rendered base64url
 * (43 characters, 256 bits of entropy). The contract accepts a wider band so
 * a future widening is not a breaking change, and rejects anything long
 * enough to be an attempt at something other than a token.
 */
export const EMAIL_VERIFICATION_TOKEN_MAX_LENGTH = 128;

export const VerifyEmailRequestSchema = z
  .object({
    token: z.string().min(1, 'token is required').max(EMAIL_VERIFICATION_TOKEN_MAX_LENGTH),
  })
  .strict();
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

/**
 * Verification response.
 *
 * Carries the account's id and resulting status and nothing else — notably no
 * session. Verifying an email address proves control of the mailbox, not
 * possession of the password, so minting a session here would turn a
 * forwarded verification link into a login. The client's next step is the
 * ordinary login it was already going to make.
 *
 * `status` is the full enum rather than `z.literal('active')` because a token
 * belonging to a user who was suspended between minting and clicking must
 * report what actually happened. Verification does not resurrect a suspended
 * account.
 */
export const VerifyEmailResponseSchema = z
  .object({
    userId: z.string().min(1).max(64),
    status: UserStatusSchema,
    verifiedAt: z.string().datetime(),
  })
  .strict();
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

export const ResendVerificationEmailRequestSchema = z
  .object({
    email: z
      .string()
      .min(1, 'email is required')
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`),
  })
  .strict();
export type ResendVerificationEmailRequest = z.infer<typeof ResendVerificationEmailRequestSchema>;

/**
 * Resend response — a fixed acknowledgement, returned with 202 for every
 * input the schema accepts.
 *
 * The body deliberately carries no information about the address. A response
 * that differed for a registered address, an unregistered one, and an already
 * verified one would be a three-way account-enumeration oracle on an
 * unauthenticated endpoint — the same reasoning that keeps signup's 409 from
 * naming the field (see `SignupResponseSchema`) and login's 401 from
 * distinguishing no-such-user from wrong-password.
 */
export const ResendVerificationEmailResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();
export type ResendVerificationEmailResponse = z.infer<typeof ResendVerificationEmailResponseSchema>;

/**
 * Machine-readable `code` values on the RFC 7807 body of a rejected
 * verification. All three are returned with the same 400 status and the same
 * human-facing `detail`, so the code is for the client's own branching (offer
 * a resend button vs. tell the user to log in) and never a signal a prober
 * could use — an attacker holding a random string always gets
 * `invalid_token`, and only the holder of a real token can distinguish
 * `expired` from `already_consumed`.
 */
export const EMAIL_VERIFICATION_PROBLEM_CODE = {
  invalidToken: 'invalid_token',
  expired: 'verification_token_expired',
  alreadyConsumed: 'verification_token_already_consumed',
} as const;
export type EmailVerificationProblemCode =
  (typeof EMAIL_VERIFICATION_PROBLEM_CODE)[keyof typeof EMAIL_VERIFICATION_PROBLEM_CODE];
