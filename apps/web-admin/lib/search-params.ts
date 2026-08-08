/**
 * Search-parameter readers shared by every web-admin server component
 * (TS-303c2b-followup-1a).
 *
 * These four functions had accumulated as **29 byte-identical copies of
 * `readBanner`**, seven of `readString`, four of `readEnum` and two of
 * the offset parser, one per page, because each surface grew from the
 * last one by copy-paste. Nothing about them is page-specific, and
 * nothing about them was tested — they sat below the fold of `.tsx`
 * files that the unit-test lane deliberately cannot reach
 * (TS-303c2b-followup-1).
 *
 * They all share one input shape, Next's `searchParams`: a record whose
 * values are `string`, `string[]` (a repeated key) or `undefined`. The
 * discipline throughout is that **a repeated or malformed parameter is
 * treated as absent, never as an error and never coerced**. These values
 * come off a URL an operator may have edited, truncated or had mangled
 * by a mail client; a 400 or a crash on the way into an admin console
 * turns a cosmetic mistake into a surface nobody can open. The
 * downstream service is still the authority on what it will accept.
 */

/** Next's `searchParams` shape, spelled once. */
export type SearchParams = Record<string, string | string[] | undefined> | undefined;

/**
 * The post-action banner state. `ok` carries nothing — the page supplies
 * its own success wording — and `err` carries only a short machine code
 * the page maps to copy, never text from a service.
 *
 * (Downstream text reaches a page through `problem-detail.ts`, which
 * sanitises it. Keeping that path separate is deliberate: this one is a
 * closed set of codes we wrote, that one is text somebody else wrote.)
 */
export type Banner = { readonly kind: 'ok' } | { readonly kind: 'err'; readonly code: string };

/**
 * Read the `?action=ok` / `?action=err&code=…` banner a server action
 * redirects back with.
 *
 * An `err` with no readable `code` becomes `'unknown'` rather than null:
 * something failed, and the operator must be told that much even when we
 * cannot say what. Silently rendering no banner would let a failed action
 * look like a successful one.
 */
export function readBanner(search: SearchParams): Banner | null {
  if (search === undefined) return null;
  const action = search['action'];
  if (action === 'ok') return { kind: 'ok' };
  if (action === 'err') {
    const code = search['code'];
    return { kind: 'err', code: typeof code === 'string' ? code : 'unknown' };
  }
  return null;
}

/**
 * Read a non-empty string parameter, or `undefined`.
 *
 * An empty string collapses to `undefined` so `?q=` means "no filter"
 * rather than "match the empty string" — which is what a cleared search
 * box submits, and the two must not diverge.
 */
export function readString(search: SearchParams, key: string): string | undefined {
  if (search === undefined) return undefined;
  const raw = search[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Read a parameter constrained to an allow-list, or `undefined`.
 *
 * A value outside the set is dropped rather than passed through: these
 * feed status and kind filters on admin queues, and forwarding an unknown
 * one either 400s the gateway or — worse — returns an empty list that
 * reads as "there is nothing here".
 */
export function readEnum(
  search: SearchParams,
  key: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const raw = readString(search, key);
  return raw !== undefined && allowed.has(raw) ? raw : undefined;
}

/**
 * Read a zero-based pagination offset, defaulting to the first page.
 *
 * A malformed `offset` falls back to 0 rather than 400ing the whole
 * screen: the gateway would reject it anyway, and an operator who mangled
 * a URL should land on the first page of the list, not on an error page.
 * Negative and non-integer values are malformed for the same reason.
 */
export function readOffset(value: string | string[] | undefined): number {
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}
