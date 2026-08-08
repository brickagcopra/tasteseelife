/**
 * Sentry event scrubbing (CLAUDE.md §3.9, §10, §17.2).
 *
 * Sentry is a third-party processor and an error report is the single
 * richest accidental PII channel this platform has: it carries request
 * bodies, headers, breadcrumbs, and — if the wrong integration is enabled —
 * the local variables of the frame that threw. §17.2 bans "logging secrets,
 * tokens, or unredacted PII" and a hosted error tracker is logging.
 *
 * So every event passes `scrubSentryEvent` in `beforeSend` and every
 * breadcrumb passes `scrubBreadcrumb` in `beforeBreadcrumb`. Both are pure
 * and SDK-free (type-only imports), which is why they live behind the
 * package's `.` subpath: the Next.js portals share these exact rules through
 * `@sentry/nextjs` without taking a runtime dependency on `@sentry/node`.
 *
 * The walk is depth-agnostic on purpose — see `redaction.ts` for why key
 * NAMES rather than paths are the unit of matching here.
 */

import type { Breadcrumb, Event } from '@sentry/node';

import { REDACTION_CENSOR, isSensitiveKey } from './redaction';

/**
 * The three shapes `RequestEventData.query_string` can take. Declared here
 * because `@sentry/node` re-exports the value surface but not this type, and
 * reaching into `@sentry/core`'s build output for it would couple us to the
 * SDK's internal file layout.
 */
export type QueryParams = string | { [key: string]: string } | Array<[string, string]>;

/**
 * Maximum object depth walked before bailing out. Sentry's own normalisation
 * truncates at depth 3 by default, so this is generous; it exists to bound
 * the walk on a pathological structure, not to shape the payload.
 *
 * At the limit we return a marker rather than the value: returning the value
 * unscrubbed would make the depth cap a PII bypass, and using the redaction
 * censor would tell the operator "we removed this for privacy" when the real
 * reason was structural.
 */
const MAX_DEPTH = 12;
const DEPTH_MARKER = '[REDACTED:max-depth]';

/**
 * True for objects we walk into. Excludes `null`, arrays (handled
 * separately) and exotic instances (Date, RegExp, Buffer, Error) — those
 * serialise to scalars or are handled by Sentry's own normalisation, and
 * walking them would rewrite their shape.
 */
function isPlainish(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively censor every sensitive-named property in `value`, at any depth.
 *
 * Cycle-safe (a seen-set of visited objects) because Sentry `extra` regularly
 * carries user-supplied structures and a self-referencing object in an error
 * report must not take the process down with it — the reporting path failing
 * loudly is strictly worse than the error it was reporting.
 */
export function scrubValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return DEPTH_MARKER;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((entry) => scrubValue(entry, seen, depth + 1));
  }

  if (isPlainish(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTION_CENSOR : scrubValue(entry, seen, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Scrub a URL query string, which arrives in three shapes depending on which
 * SDK produced the event: the raw `a=1&b=2` string, a tuple list, or an
 * object. Key-name walking only reaches the object form, and the raw string
 * is the form most likely to carry a credential — a magic-link or password
 * reset URL is `?token=...` by construction.
 */
export function scrubQueryString(query: QueryParams): QueryParams {
  if (typeof query === 'string') {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    let mutated = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTION_CENSOR);
        mutated = true;
      }
    }
    return mutated ? params.toString() : query;
  }

  if (Array.isArray(query)) {
    return query.map(([key, value]): [string, string] =>
      isSensitiveKey(key) ? [key, REDACTION_CENSOR] : [key, value],
    );
  }

  return scrubValue(query) as QueryParams;
}

/**
 * Scrub a request body that arrived as a raw string.
 *
 * Only JSON is rewritten. A non-JSON string body is left alone rather than
 * dropped: on this platform a non-JSON body is a form post or an upload
 * (which go direct-to-S3 per §3.4 and never reach a service), and blanket-
 * censoring every unparseable body would remove the payload that makes a
 * 500 diagnosable while removing no known secret.
 */
function scrubStringBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isPlainish(parsed) && !Array.isArray(parsed)) return body;
  return JSON.stringify(scrubValue(parsed));
}

/**
 * `beforeSend` hook. Returns the scrubbed event — never `null`, because
 * dropping the event would hide the error, and the point of the scrub is to
 * make the error reportable rather than to suppress it.
 *
 * Generic in the event type so it satisfies `beforeSend` (which narrows to
 * `ErrorEvent`, whose `type` is pinned to `undefined`) without widening the
 * SDK's own signature at the call site.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  const scrubbed = scrubValue(event) as T;

  if (scrubbed.request !== undefined) {
    if (scrubbed.request.query_string !== undefined) {
      scrubbed.request.query_string = scrubQueryString(scrubbed.request.query_string);
    }
    if (typeof scrubbed.request.data === 'string') {
      scrubbed.request.data = scrubStringBody(scrubbed.request.data);
    }
    // A URL can carry the credential in its own query component even when
    // `query_string` was never populated separately.
    if (typeof scrubbed.request.url === 'string') {
      scrubbed.request.url = scrubUrl(scrubbed.request.url);
    }
  }

  if (scrubbed.user !== undefined) {
    // `sendDefaultPii: false` already keeps the SDK from attaching this, but
    // a call site can set it explicitly on the scope. The IP of a family
    // member checking on a senior is PII we have no reason to ship to a
    // third party (§10, PDD §16.3).
    delete scrubbed.user.ip_address;
  }

  return scrubbed;
}

/** Strip credential-bearing query params from a URL, preserving the rest. */
export function scrubUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const scrubbedQuery = scrubQueryString(url.slice(q + 1));
  return typeof scrubbedQuery === 'string' ? `${url.slice(0, q)}?${scrubbedQuery}` : url;
}

/**
 * `beforeBreadcrumb` hook. Breadcrumbs are the leakiest surface of the three
 * (they accumulate silently and are attached to whatever error happens to
 * come next), so `data` is walked with the same rules and `message` — free
 * text we cannot inspect structurally — is left to the call site.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.data === undefined) return breadcrumb;
  return { ...breadcrumb, data: scrubValue(breadcrumb.data) as Record<string, unknown> };
}
