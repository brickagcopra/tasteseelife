import { cookies } from 'next/headers';

import { FLASH_COOKIE_NAME, decodeFlash, encodeFlash, type FlashPayload } from './flash-types';

export {
  FLASH_COOKIE_NAME,
  decodeFlash,
  encodeFlash,
  FlashPayloadSchema,
  type FlashKind,
  type FlashPayload,
} from './flash-types';

/**
 * Server-side cookie surface for the one-shot flash channel
 * (TS-215-followup-3).
 *
 * Server actions write a short UX hint into the `tas_family_flash`
 * cookie via {@link setFlash} just before they `redirect()`. The next
 * protected-layout render reads the cookie via {@link readFlash} and
 * hands the payload to the client `<FlashBanner />`, which displays
 * the banner and immediately clears `document.cookie` so a refresh
 * does not redisplay it.
 *
 * Why this cookie is NOT HttpOnly: a flash payload carries no secret
 * content — only a short kind/code/message UX hint. Making the value
 * JS-readable lets the client renderer clear it after display, which
 * is the only way to implement a true one-shot channel in the Next 15
 * App Router (cookies cannot be mutated during a Server Component
 * render — only in server actions / route handlers). The 30-second
 * max-age is a defence-in-depth fallback: if the client never mounts
 * (e.g. a hard nav to an HTML-only page), the cookie expires
 * naturally before the user sees the same toast twice.
 *
 * Mirrors the `?expired=1` query-flag pattern but for transient
 * errors that don't justify a query-string round-trip.
 *
 * Pure types + codec live in `lib/flash-types.ts` so the client
 * banner can import them without pulling `next/headers` (which Next
 * 15 forbids from client components).
 */

/**
 * Defence-in-depth max-age. The renderer clears the cookie on mount,
 * so in the happy path this never fires; the TTL only matters when
 * the client never mounts (HTML-only pages, navigation before
 * hydration, JS disabled).
 */
const FLASH_COOKIE_MAX_AGE_SECONDS = 30;

/**
 * Write a flash payload to the response cookie jar. Must be called
 * from a server action (Next 15 forbids cookie mutation during a
 * Server Component render).
 *
 * The cookie is intentionally NOT HttpOnly — see file-level doc.
 */
export async function setFlash(payload: FlashPayload): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const jar = await cookies();
  jar.set(FLASH_COOKIE_NAME, encodeFlash(payload), {
    httpOnly: false,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: FLASH_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * Read the flash cookie from the request jar. Returns `null` when the
 * cookie is absent, malformed, or schema-invalid. Does NOT clear the
 * cookie — clearing happens client-side after the banner renders.
 */
export async function readFlash(): Promise<FlashPayload | null> {
  const jar = await cookies();
  const value = jar.get(FLASH_COOKIE_NAME)?.value;
  return decodeFlash(value);
}
