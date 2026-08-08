import { Logger } from '@nestjs/common';
import type { RecordAssetEventRequest } from '@taste-and-see/contracts';

import type { ScanEventClientPort } from '../ports';

/** Narrow `fetch` shape so tests can inject a fake without `lib.dom`. */
export type FetchFn = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface HttpScanEventClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeader: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch` (Node 22 native). */
  readonly fetchFn?: FetchFn;
}

const INGEST_PATH = '/api/v1/internal/media/scan-events';

/**
 * Live scan-event client — POSTs `RecordAssetEventRequest` payloads to
 * media-svc's internal ingest (TS-110 `ScanEventsController`,
 * `InternalSharedSecretGuard`-pinned). Throws on a non-2xx / transport
 * error so the orchestrator returns `emit_error` and the job source
 * retries (media-svc dedups on `(assetId, eventKind)`, so the replay is
 * a no-op).
 *
 * The shared secret rides the configured header (NEVER logged — only the
 * status + assetId/eventKind appear in log lines, CLAUDE.md §3.9).
 */
export class HttpScanEventClient implements ScanEventClientPort {
  private readonly endpoint: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: HttpScanEventClientOptions) {
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}${INGEST_PATH}`;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  async record(event: RecordAssetEventRequest): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [this.opts.apiKeyHeader]: this.opts.apiKey,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await safeText(res);
        throw new Error(
          `scan-event ingest returned ${res.status} for asset=${event.assetId} event=${event.eventKind}: ${detail}`,
        );
      }
    } catch (err) {
      // Re-throw with a stable shape; never include the secret/header.
      throw err instanceof Error
        ? err
        : new Error(`scan-event ingest failed for asset=${event.assetId} event=${event.eventKind}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    const body = await res.text();
    return body.slice(0, 512);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Fallback used when no `SCAN_EVENT_INGEST_URL` is configured (stub / dev
 * mode). Logs the event at info and resolves — so a locally-seeded job
 * completes visibly without media-svc reachable, rather than spinning on
 * retries. Production pods always configure the URL.
 */
export class LoggingScanEventClient implements ScanEventClientPort {
  private readonly log = new Logger(LoggingScanEventClient.name);

  record(event: RecordAssetEventRequest): Promise<void> {
    this.log.log(
      { assetId: event.assetId, eventKind: event.eventKind },
      'media-processor: scan-event ingest not configured; logging event only (stub mode)',
    );
    return Promise.resolve();
  }
}
