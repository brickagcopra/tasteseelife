/**
 * Module-options shape for `PagerDutyModule.forRoot(...)`.
 *
 * `source` becomes `payload.source` on every event — it names the emitting
 * service in the responder's PagerDuty timeline. It is **required** here,
 * deliberately: the service-local client this package was extracted from
 * (TS-225, service-concierge) defaulted it to `'service-concierge'` via a
 * zod `.default(...)`, which is exactly the kind of value that goes wrong
 * silently once a second service pages on-call — trust-safety's welfare
 * escalations (TS-302d) would page as if they came from concierge. A
 * required option makes the wrong answer unrepresentable rather than merely
 * unlikely. Hosts still read it from env (`PAGERDUTY_SOURCE`) and may keep
 * their own default there.
 *
 * `routingKey` is the Events API v2 routing (integration) key — the
 * credential. It is OPTIONAL: unset disables paging entirely
 * (`skipped_unconfigured`) so a service boots and its durable domain record
 * still lands when paging is not yet configured. Sourced from Vault / a
 * cloud secret manager in real environments (CLAUDE.md §3.5), never
 * committed.
 *
 * `eventsUrl` defaults to the public US enqueue endpoint; override for the
 * EU service region or a test double.
 *
 * `timeoutMs` bounds a single page. An on-call page must resolve fast or
 * fail fast — the domain record is already durable, and the call must never
 * block an HTTP response beyond this bound (CLAUDE.md §7.2).
 */
export interface PagerDutyModuleOptions {
  readonly source: string;
  readonly routingKey?: string | undefined;
  readonly eventsUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ValidatedPagerDutyOptions {
  readonly source: string;
  readonly routingKey: string | undefined;
  readonly eventsUrl: string;
  readonly timeoutMs: number;
}

/** Public US Events API v2 enqueue endpoint. */
export const DEFAULT_PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

/** Default per-page request timeout. Mirrors the TS-225 concierge default. */
export const DEFAULT_PAGERDUTY_TIMEOUT_MS = 5_000;

/**
 * Ceiling on `timeoutMs`. Mirrors the concierge env bound — anything longer
 * is not a "fail fast" page, it is a hung request holding a handler open.
 */
const MAX_PAGERDUTY_TIMEOUT_MS = 30_000;

export class PagerDutyConfigError extends Error {
  constructor(message: string) {
    super(`@taste-and-see/nest-pagerduty: ${message}`);
    this.name = 'PagerDutyConfigError';
  }
}

/**
 * Validate + apply defaults at module-definition time, so a misconfigured
 * host fails at boot rather than at the moment someone's emergency needs a
 * page. Returns a frozen object bound to `PAGERDUTY_OPTIONS_TOKEN`.
 */
export function validatePagerDutyOptions(
  options: PagerDutyModuleOptions,
): ValidatedPagerDutyOptions {
  if (typeof options.source !== 'string' || options.source.trim().length === 0) {
    throw new PagerDutyConfigError('source must be a non-empty string (name the emitting service)');
  }

  if (options.routingKey !== undefined) {
    if (typeof options.routingKey !== 'string' || options.routingKey.length === 0) {
      throw new PagerDutyConfigError(
        'routingKey must be a non-empty string when provided (omit it to disable paging)',
      );
    }
  }

  const eventsUrl = options.eventsUrl ?? DEFAULT_PAGERDUTY_EVENTS_URL;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(eventsUrl);
  } catch {
    throw new PagerDutyConfigError(`eventsUrl must be a valid URL (received "${eventsUrl}")`);
  }
  // http is admitted only so a local test double can stand in; every real
  // region endpoint is https. This is NOT TLS-verification relaxation
  // (CLAUDE.md §17.9) — the transport for a real endpoint stays https.
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new PagerDutyConfigError(
      `eventsUrl must be an http(s) URL (received protocol "${parsedUrl.protocol}")`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGERDUTY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PagerDutyConfigError('timeoutMs must be a positive integer');
  }
  if (timeoutMs > MAX_PAGERDUTY_TIMEOUT_MS) {
    throw new PagerDutyConfigError(
      `timeoutMs must be <= ${MAX_PAGERDUTY_TIMEOUT_MS} (a page fails fast; the domain record is already durable)`,
    );
  }

  return Object.freeze({
    source: options.source,
    routingKey: options.routingKey,
    eventsUrl,
    timeoutMs,
  });
}
