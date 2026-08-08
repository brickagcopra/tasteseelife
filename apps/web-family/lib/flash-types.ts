import { z } from 'zod';

/**
 * Pure types + codec for the flash-message channel (TS-215-followup-3).
 *
 * Kept separate from `lib/flash.ts` because the cookie read/write
 * surface there imports `next/headers`, which Next 15 forbids from
 * client components. The client `<FlashBanner />` needs the type +
 * cookie-name constant, so the pure values live here and the
 * `next/headers`-touching code lives in `lib/flash.ts`.
 */

/** Cookie name carrying the flash payload. JS-readable by design. */
export const FLASH_COOKIE_NAME = 'tas_family_flash';

/**
 * Conservative ceiling on the encoded JSON payload. We never write
 * anything close to this, but a malformed cookie (manually tampered)
 * shouldn't blow up `JSON.parse` or take the request path with it.
 * RFC 6265 allows up to ~4 KB per cookie; 2 KB leaves headroom.
 */
const FLASH_PAYLOAD_MAX_LENGTH = 2048;

const FlashKindSchema = z.enum(['success', 'error', 'info']);

export const FlashPayloadSchema = z
  .object({
    kind: FlashKindSchema,
    /**
     * Short kebab-case identifier scoped to the action that wrote the
     * flash. The renderer maps `code` to user-facing copy so the
     * action layer stays copy-agnostic (translations + copy edits do
     * not require an action-layer redeploy).
     */
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9_.-]+$/, 'code must be kebab-case identifier'),
    /** Optional free-text override. Renderer falls back to the code's copy when absent. */
    message: z.string().max(280).optional(),
  })
  .strict();

export type FlashKind = z.infer<typeof FlashKindSchema>;
export type FlashPayload = z.infer<typeof FlashPayloadSchema>;

/**
 * Encode a flash payload for cookie transport. Returns the URL-encoded
 * JSON string suitable for `cookies().set(...)`.
 *
 * Exported separately from the cookie-writing surface so unit tests
 * can exercise the encoder/decoder pair without depending on Next.js'
 * `cookies()` API (async + request-scoped + only callable inside a
 * request handler).
 */
export function encodeFlash(payload: FlashPayload): string {
  const validated = FlashPayloadSchema.parse(payload);
  return encodeURIComponent(JSON.stringify(validated));
}

/**
 * Decode and validate a cookie value into a {@link FlashPayload}.
 * Returns `null` for any malformed, oversized, or schema-invalid input
 * so the renderer never crashes on tampered cookies.
 */
export function decodeFlash(raw: string | undefined | null): FlashPayload | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > FLASH_PAYLOAD_MAX_LENGTH) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const validated = FlashPayloadSchema.safeParse(parsed);
  return validated.success ? validated.data : null;
}
