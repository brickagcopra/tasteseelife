import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import { err, ok, type Result } from './result';

/**
 * Failure shapes returned by `CheckrClient`. Modelled as a
 * discriminated union so callers can branch on the specific reason
 * without inspecting raw HTTP error shapes (CLAUDE.md §2.1).
 */
export type CheckrFailure =
  | { readonly reason: 'checkr_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string }
  | {
      readonly reason: 'unexpected_response';
      readonly status: number;
      readonly bodySnippet: string;
    };

/**
 * Subset of Checkr's `candidate` response we surface. Checkr returns
 * dozens of fields; the projection keeps only the id we need to
 * round-trip to subsequent calls. PII never lives in this projection.
 */
export interface CheckrCandidate {
  readonly id: string;
}

/**
 * Subset of Checkr's `report` response we surface. `status` is
 * Checkr's free-text status string (we map it to our local
 * `BackgroundCheckStatus` in `BackgroundCheckService`).
 */
export interface CheckrReport {
  readonly id: string;
  readonly status: string;
}

/**
 * Input for `createCandidate`. PII passes through this object on a
 * direct call to Checkr — it is NEVER persisted on our side. CLAUDE.md
 * §17.1 (no SSN / DOB unencrypted) is enforced at the persistence
 * layer above (`provider_background_checks` holds only the opaque
 * `checkr_candidate_id`).
 */
export interface CreateCandidateInput {
  readonly firstName: string;
  readonly middleName?: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  /** ISO date string (YYYY-MM-DD). */
  readonly dob: string;
  /** Last 4 digits of SSN — optional but required for criminal checks. */
  readonly ssnLast4?: string;
  /** ZIP code where the candidate resides. */
  readonly zipcode: string;
  /**
   * Optional Checkr-side idempotency key. Forwarded as the
   * `Idempotency-Key` header so a network retry within Checkr's
   * dedup window returns the same candidate row rather than creating
   * a duplicate. Separate from the Redis-backed CLAUDE.md §3.3
   * replay cache on our own endpoint.
   */
  readonly idempotencyKey?: string;
}

export interface CreateReportInput {
  readonly candidateId: string;
  /** Checkr package slug (e.g. `tasker_standard`). */
  readonly packageSlug: string;
  /**
   * US state codes the candidate intends to work in (Checkr uses
   * these to compose the appropriate jurisdictional checks).
   */
  readonly workLocationStates: readonly string[];
  readonly idempotencyKey?: string;
}

/**
 * Thin wrapper around Checkr's REST API (`api.checkr.com/v1/`).
 *
 * **Why a hand-written client** instead of an SDK: Checkr does not
 * ship an officially supported Node SDK; the REST API is well-
 * documented and the calls are a handful of POSTs. A thin fetch
 * wrapper is easier to test (no SDK to stub) and cheaper to keep
 * current than a community SDK with its own release cadence.
 *
 * **Auth model**. HTTP Basic-Auth with the Checkr API key in the
 * username slot and an empty password. Production uses the live
 * secret; dev / staging uses the test-mode secret.
 *
 * **PII discipline**. Inputs to `createCandidate` carry full applicant
 * PII (name + DOB + SSN-last-4 + zipcode); the client never logs
 * them. Only the returned candidate id is logged.
 *
 * **Result-shaped boundary**. All public methods return
 * `Result<T, CheckrFailure>` so the caller cannot swallow a Checkr
 * error with a generic try/catch (CLAUDE.md §2.1 / §3.9).
 */
@Injectable()
export class CheckrClient {
  private readonly logger = new Logger(CheckrClient.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authHeader: string;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.apiKey = env.CHECKR_API_KEY;
    this.baseUrl = env.CHECKR_API_BASE_URL.replace(/\/+$/, '');
    this.timeoutMs = env.CHECKR_REQUEST_TIMEOUT_MS;
    // HTTP Basic-Auth with the API key in the username slot and an
    // empty password — the Checkr API contract. Pre-compute the
    // header so every request reuses the same string.
    this.authHeader = `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
  }

  async createCandidate(
    input: CreateCandidateInput,
  ): Promise<Result<CheckrCandidate, CheckrFailure>> {
    const validationError = validateCandidateInput(input);
    if (validationError !== null) {
      return err({ reason: 'invalid_request', message: validationError });
    }

    const body: Record<string, unknown> = {
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      phone: input.phone,
      dob: input.dob,
      zipcode: input.zipcode,
    };
    if (input.middleName !== undefined) {
      body['middle_name'] = input.middleName;
    }
    if (input.ssnLast4 !== undefined) {
      // Checkr accepts either the full SSN or the last 4 in the
      // `ssn` field. Phase 1 sends only the last 4; the full SSN is
      // never collected from the applicant.
      body['ssn'] = input.ssnLast4;
    }

    const result = await this.request<{ id?: unknown }>('POST', '/candidates', {
      body,
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
    });
    if (!result.ok) return result;

    const candidateId = typeof result.value['id'] === 'string' ? result.value['id'] : null;
    if (candidateId === null || candidateId.length === 0) {
      return err({
        reason: 'unexpected_response',
        status: 200,
        bodySnippet: 'candidate.id missing',
      });
    }

    this.logger.log({ candidateId }, 'checkr.createCandidate ok');
    return ok({ id: candidateId });
  }

  async createReport(input: CreateReportInput): Promise<Result<CheckrReport, CheckrFailure>> {
    if (input.candidateId.length === 0) {
      return err({ reason: 'invalid_request', message: 'candidateId is required' });
    }
    if (input.packageSlug.length === 0) {
      return err({ reason: 'invalid_request', message: 'packageSlug is required' });
    }
    if (input.workLocationStates.length === 0) {
      return err({
        reason: 'invalid_request',
        message: 'workLocationStates must contain at least one state code',
      });
    }

    const body = {
      candidate_id: input.candidateId,
      package: input.packageSlug,
      work_locations: input.workLocationStates.map((state) => ({ country: 'US', state })),
    };

    const result = await this.request<{ id?: unknown; status?: unknown }>('POST', '/reports', {
      body,
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
    });
    if (!result.ok) return result;

    const reportId = typeof result.value['id'] === 'string' ? result.value['id'] : null;
    const status = typeof result.value['status'] === 'string' ? result.value['status'] : null;
    if (reportId === null || reportId.length === 0) {
      return err({
        reason: 'unexpected_response',
        status: 200,
        bodySnippet: 'report.id missing',
      });
    }
    if (status === null || status.length === 0) {
      return err({
        reason: 'unexpected_response',
        status: 200,
        bodySnippet: 'report.status missing',
      });
    }

    this.logger.log({ candidateId: input.candidateId, reportId, status }, 'checkr.createReport ok');
    return ok({ id: reportId, status });
  }

  /**
   * Low-level request helper. Centralises auth header, timeout,
   * JSON serialisation, and HTTP-status classification. Test
   * suites can stub the underlying `fetch` via `vi.stubGlobal`.
   */
  private async request<TBody extends Record<string, unknown>>(
    method: 'POST',
    path: string,
    options: {
      readonly body?: Record<string, unknown>;
      readonly idempotencyKey?: string;
    },
  ): Promise<Result<TBody, CheckrFailure>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      authorization: this.authHeader,
      'content-type': 'application/json',
    };
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      this.logger.warn({ path, err: errorMessage(cause) }, 'checkr.request: network failure');
      return err({ reason: 'checkr_unavailable', cause });
    } finally {
      clearTimeout(timer);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (cause) {
      this.logger.warn(
        { path, status: response.status, err: errorMessage(cause) },
        'checkr.request: response read failed',
      );
      return err({ reason: 'checkr_unavailable', cause });
    }

    if (!response.ok) {
      this.logger.warn(
        { path, status: response.status, bodySnippet: raw.slice(0, 256) },
        'checkr.request: non-2xx',
      );
      return err({
        reason: 'unexpected_response',
        status: response.status,
        bodySnippet: raw.slice(0, 256),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (cause) {
      this.logger.warn(
        { path, status: response.status, err: errorMessage(cause) },
        'checkr.request: response JSON parse failed',
      );
      return err({
        reason: 'unexpected_response',
        status: response.status,
        bodySnippet: raw.slice(0, 256),
      });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err({
        reason: 'unexpected_response',
        status: response.status,
        bodySnippet: 'response body is not a JSON object',
      });
    }
    return ok(parsed as TBody);
  }
}

function validateCandidateInput(input: CreateCandidateInput): string | null {
  if (input.firstName.length === 0) return 'firstName is required';
  if (input.lastName.length === 0) return 'lastName is required';
  if (input.email.length === 0) return 'email is required';
  if (input.phone.length === 0) return 'phone is required';
  if (input.dob.length === 0) return 'dob is required';
  if (input.zipcode.length === 0) return 'zipcode is required';
  if (input.ssnLast4 !== undefined && !/^[0-9]{4}$/.test(input.ssnLast4)) {
    return 'ssnLast4 must be exactly 4 digits';
  }
  return null;
}

function errorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const m = (cause as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'unknown error';
}
