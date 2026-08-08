import { randomBytes } from 'node:crypto';

/**
 * Verification-token generation (TS-255; PRD §9.3; PDD §15.2 — "public-facing
 * verification URL").
 *
 * The token is the unguessable key in the public `/verify/cert/{token}` URL —
 * the ONLY thing standing between an anonymous request and a certificate's
 * (deliberately public, diploma-style) holder + course facts. It must be
 * cryptographically random so a third party cannot enumerate other holders'
 * certificates by guessing tokens.
 *
 * 24 random bytes → base64url (no padding) → a 32-char URL-safe string
 * (`[A-Za-z0-9_-]`), comfortably under the 64-char contract cap. 192 bits of
 * entropy makes enumeration infeasible.
 *
 * Exposed as a plain function so the service can inject it (defaulted ctor
 * arg) and tests can pass a deterministic stub.
 */
export function generateVerificationToken(): string {
  return randomBytes(24).toString('base64url');
}
