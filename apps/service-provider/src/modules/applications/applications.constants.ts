/**
 * Applications-module shared constants.
 *
 * `BACKGROUND_CHECK_DISPATCH_HEADER_NAME` — the HTTP header carrying
 * the shared secret on the internal Checkr-dispatch route. The
 * route's controller reads this; service-webhook's dispatcher sets it
 * (the header name is duplicated there per CLAUDE.md §2.3 — cross-
 * service constants are routinely duplicated; the contract that binds
 * them is the Zod schema in `packages/contracts`).
 *
 * `BACKGROUND_CHECK_DISPATCH_PATH` — the URL path for the internal
 * dispatch endpoint. service-webhook composes its dispatch URL by
 * concatenating its `BACKGROUND_CHECK_DISPATCH_URL` env var (base +
 * path).
 */
export const BACKGROUND_CHECK_DISPATCH_HEADER_NAME = 'x-background-check-internal-api-key';
export const BACKGROUND_CHECK_DISPATCH_PATH = 'api/v1/internal/providers/background-check-events';
