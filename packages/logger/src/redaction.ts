/**
 * Default PII redaction paths applied at the logger layer (CLAUDE.md §10).
 *
 * Why redact at the logger and not the call site:
 * - Call-site redaction is easy to forget and trivial to bypass with a stack
 *   trace, error object, or third-party logger that doesn't know our rules.
 * - The logger sees every log line, so a fast-redact path here is the only
 *   place we can guarantee the platform never emits an unredacted secret or
 *   PII to stdout, Loki, or third-party log shippers.
 *
 * What is covered:
 * - Auth credentials and tokens (CLAUDE.md §3.1, §3.5, §3.9)
 * - HTTP `Authorization` and `Cookie` headers (covers most accidental
 *   `req` / `res` log dumps)
 * - Personal identifiers (SSN, DOB, email, phone) — flagged as PII per
 *   CLAUDE.md §10 and PDD §16.3
 * - Payment-card primitives (PAN, CVV) — PCI scope avoidance per CLAUDE.md
 *   §3.9 and §17.1
 * - Health-flagged senior data (dementia status, medical notes, allergies,
 *   medications) — HIPAA-aligned per PDD §16.3
 *
 * Wildcards: pino's `fast-redact` engine supports a single-level `*.field`
 * wildcard. Deeper nesting is handled by adding explicit paths or, in
 * services with rich payloads, by extending `redactPaths` in `createLogger`.
 *
 * Censor: `[REDACTED]` (string sentinel). `remove: false` is set in
 * `createLogger` so the field is preserved in shape — log analytics can still
 * see "this field was present" without learning its value.
 */

const AUTH_PATHS = [
  // Direct credential fields
  'password',
  'passwordHash',
  'pass',
  'pwd',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'jwt',
  'sessionToken',
  'authorization',
  'apiKey',
  'api_key',
  'secret',
  'clientSecret',
  'webhookSecret',
  // Single-level nested credential fields
  '*.password',
  '*.passwordHash',
  '*.pass',
  '*.pwd',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.jwt',
  '*.sessionToken',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.clientSecret',
] as const;

const HEADER_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
  'response.headers["set-cookie"]',
] as const;

const PERSONAL_PATHS = [
  'ssn',
  'socialSecurityNumber',
  'dob',
  'dateOfBirth',
  'taxId',
  'email',
  'phone',
  'phoneNumber',
  '*.ssn',
  '*.socialSecurityNumber',
  '*.dob',
  '*.dateOfBirth',
  '*.taxId',
  '*.email',
  '*.phone',
  '*.phoneNumber',
] as const;

const PAYMENT_PATHS = [
  'cardNumber',
  'pan',
  'cvv',
  'cvc',
  'cardholderName',
  '*.cardNumber',
  '*.pan',
  '*.cvv',
  '*.cvc',
  '*.cardholderName',
] as const;

const HEALTH_PATHS = [
  'dementiaStatus',
  'medicalNotes',
  'allergies',
  'medications',
  '*.dementiaStatus',
  '*.medicalNotes',
  '*.allergies',
  '*.medications',
] as const;

export const DEFAULT_REDACT_PATHS: readonly string[] = Object.freeze([
  ...AUTH_PATHS,
  ...HEADER_PATHS,
  ...PERSONAL_PATHS,
  ...PAYMENT_PATHS,
  ...HEALTH_PATHS,
]);

export const REDACTION_CENSOR = '[REDACTED]' as const;
