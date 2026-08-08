import { Inject, Injectable } from '@nestjs/common';

import type { ValidatedPagerDutyOptions } from './module/options';
import { PAGERDUTY_OPTIONS_TOKEN } from './module/tokens';

/**
 * PagerDuty Events API v2 client (extracted from service-concierge's TS-225
 * client by TS-302b; PDD §20.5). Pages an on-call rotation when a domain
 * event needs a human now — an emergency concierge request (TS-225), a
 * high-severity welfare flag (TS-302d).
 *
 * The Events API v2 enqueue endpoint is a plain authenticated HTTPS POST —
 * no SDK is needed, so this adds no approved-library dependency (CLAUDE.md
 * §13). The routing (integration) key is the credential; it is OPTIONAL
 * (sourced from Vault / a secret manager in real environments, CLAUDE.md
 * §3.5) so a service boots and its durable domain record is always written
 * even when paging is not yet configured.
 *
 * **Best-effort, never throws.** The durable domain record (escalated
 * ticket, incident) is the source of truth; the page is a notification on
 * top. Every failure mode (unset key, non-2xx response, network error,
 * timeout) resolves to a result the caller logs + meters rather than an
 * exception that could roll back that write or fail the user's request.
 *
 * **No free-text in the payload.** The custom details carry only
 * operational identifiers (record id, household id, a category) — a user's
 * free-text note may carry PII typed in the moment, so it stays out of the
 * third-party paging system (CLAUDE.md §3.9). The summary links the
 * responder to the ops console where the full detail lives. This is a
 * caller contract, not something the client can enforce: `customDetails` is
 * whatever the caller passes.
 */

/** Outcome of an enqueue attempt — the caller logs + meters by kind. */
export type PagerDutyEnqueueResult =
  | { readonly kind: 'sent'; readonly dedupKey: string }
  | { readonly kind: 'skipped_unconfigured' }
  | { readonly kind: 'failed'; readonly detail: string };

/** PagerDuty Events API v2 severity levels. */
export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

export interface PagerDutyEnqueueInput {
  /**
   * Deduplication key — repeated triggers (e.g. an idempotency-key retry, or
   * a double-tap before the first page resolves) collapse onto one PagerDuty
   * alert rather than paging twice.
   */
  readonly dedupKey: string;
  /** One-line alert summary (no PII). */
  readonly summary: string;
  readonly severity: PagerDutySeverity;
  /** Operational identifiers only — never free-text / PII. */
  readonly customDetails: Readonly<Record<string, string>>;
}

/** Cap on the detail string surfaced from a failed page (keeps logs bounded). */
const MAX_FAILURE_DETAIL_LENGTH = 500;

@Injectable()
export class PagerDutyClient {
  constructor(
    @Inject(PAGERDUTY_OPTIONS_TOKEN) private readonly options: ValidatedPagerDutyOptions,
  ) {}

  /**
   * Enqueue a `trigger` event on the PagerDuty Events API v2. Resolves to a
   * discriminated result; never throws.
   */
  async enqueue(input: PagerDutyEnqueueInput): Promise<PagerDutyEnqueueResult> {
    const routingKey = this.options.routingKey;
    if (routingKey === undefined) {
      return { kind: 'skipped_unconfigured' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(this.options.eventsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: 'trigger',
          dedup_key: input.dedupKey,
          payload: {
            summary: input.summary,
            source: this.options.source,
            severity: input.severity,
            custom_details: input.customDetails,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await safeReadText(response);
        return {
          kind: 'failed',
          detail: `PagerDuty responded ${response.status}: ${truncate(body)}`,
        };
      }
      return { kind: 'sent', dedupKey: input.dedupKey };
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `request timed out after ${this.options.timeoutMs}ms`
            : error.message
          : 'unknown error';
      return { kind: 'failed', detail: truncate(detail) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a response body as text without throwing on a malformed stream. */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

function truncate(value: string): string {
  return value.length > MAX_FAILURE_DETAIL_LENGTH
    ? `${value.slice(0, MAX_FAILURE_DETAIL_LENGTH)}…`
    : value;
}
