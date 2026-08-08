import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Failure reasons surfaced by the Checkr signature verifier.
 * Modelled as a discriminated union for the same reason as the
 * Stripe verifier (CLAUDE.md §2.1).
 */
export type CheckrWebhookVerificationFailure =
  | 'missing_signature_header'
  | 'malformed_signature_header'
  | 'invalid_signature'
  | 'replay_outside_tolerance'
  | 'invalid_payload_shape'
  | 'unknown';

/**
 * Minimum projection of the Checkr event envelope we surface to
 * downstream services. Checkr's full event shape carries dozens of
 * fields; the projection captures only what the persistence layer
 * needs (the byte-exact payload itself is preserved separately).
 */
export interface CheckrEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly accountId: string;
  /**
   * Checkr's `data.object` shape — typically a `Report` or
   * `Candidate`. Captured as opaque so the dispatcher can forward
   * the object id without binding to Checkr's full SDK type
   * surface.
   */
  readonly object: {
    readonly id: string;
    readonly kind: string;
    /** Free-text status string when present (e.g. `clear`). */
    readonly status: string | null;
    /** Candidate id for events where the object IS a report. */
    readonly candidateId: string | null;
  };
  /** Unix seconds — `event.created_at` parsed to seconds. */
  readonly createdSeconds: number;
}

export interface CheckrWebhookVerificationSuccess {
  readonly ok: true;
  readonly event: CheckrEventEnvelope;
  readonly payload: unknown;
  readonly verifiedAt: Date;
}

export interface CheckrWebhookVerificationFailureResult {
  readonly ok: false;
  readonly reason: CheckrWebhookVerificationFailure;
}

export type CheckrWebhookVerificationResult =
  | CheckrWebhookVerificationSuccess
  | CheckrWebhookVerificationFailureResult;

/**
 * Verifies inbound Checkr webhook requests.
 *
 * Checkr's webhook signature format: `t=<unix>,v1=<hex-sha256>`. The
 * `v1` HMAC is computed over `${timestamp}.${rawBody}` with the
 * webhook signing secret. Same shape as Stripe's signature header
 * — Checkr modelled its scheme on Stripe's. We implement the verify
 * by hand (rather than via SDK) because Checkr does not ship an
 * official Node SDK and the math is short.
 *
 * **Tolerance window** — `CHECKR_WEBHOOK_TOLERANCE_SECONDS`
 * controls replay protection. The verifier rejects requests whose
 * `t=` timestamp is outside the window relative to the local clock.
 *
 * **No payload logging** — the verifier never logs the raw body,
 * the signature header, or any Checkr-specific identifiers beyond
 * the event id and type on the success path. Checkr payloads can
 * include adverse-findings details (county records, names, dates);
 * logging them would breach CLAUDE.md §3.9 / §17.2.
 *
 * **Throws** only for misuse (programmer error): a non-Buffer raw
 * body means the raw-body parser is misconfigured upstream.
 */
@Injectable()
export class CheckrWebhookVerifierService {
  private readonly logger = new Logger(CheckrWebhookVerifierService.name);
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.secret = env.CHECKR_WEBHOOK_SECRET;
    this.toleranceSeconds = env.CHECKR_WEBHOOK_TOLERANCE_SECONDS;
  }

  verify(args: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | string[] | undefined;
    /** Override the local clock — used by tests. */
    readonly now?: Date;
  }): CheckrWebhookVerificationResult {
    if (!Buffer.isBuffer(args.rawBody)) {
      throw new TypeError(
        'CheckrWebhookVerifierService.verify expected a Buffer rawBody — the raw-body parser is not wired.',
      );
    }
    const signature = normaliseSignature(args.signatureHeader);
    if (signature === null) {
      this.logger.warn({ reason: 'missing_signature_header' }, 'checkr webhook rejected');
      return { ok: false, reason: 'missing_signature_header' };
    }

    const parsed = parseSignatureHeader(signature);
    if (parsed === null) {
      this.logger.warn({ reason: 'malformed_signature_header' }, 'checkr webhook rejected');
      return { ok: false, reason: 'malformed_signature_header' };
    }

    const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - parsed.timestamp) > this.toleranceSeconds) {
      this.logger.warn(
        {
          reason: 'replay_outside_tolerance',
          driftSeconds: Math.abs(nowSeconds - parsed.timestamp),
        },
        'checkr webhook rejected',
      );
      return { ok: false, reason: 'replay_outside_tolerance' };
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${parsed.timestamp}.${args.rawBody.toString('utf8')}`, 'utf8')
      .digest('hex');
    const provided = Buffer.from(parsed.v1, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      this.logger.warn({ reason: 'invalid_signature' }, 'checkr webhook rejected');
      return { ok: false, reason: 'invalid_signature' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(args.rawBody.toString('utf8'));
    } catch (err) {
      this.logger.warn(
        { reason: 'invalid_payload_shape', err: err instanceof Error ? err.message : 'unknown' },
        'checkr webhook rejected',
      );
      return { ok: false, reason: 'invalid_payload_shape' };
    }

    const envelope = projectEvent(payload);
    if (envelope === null) {
      this.logger.warn(
        { reason: 'invalid_payload_shape' },
        'checkr webhook rejected (envelope projection failed)',
      );
      return { ok: false, reason: 'invalid_payload_shape' };
    }

    const verifiedAt = new Date();
    this.logger.log(
      { eventId: envelope.id, eventType: envelope.type, objectId: envelope.object.id },
      'checkr webhook verified',
    );
    return { ok: true, event: envelope, payload, verifiedAt };
  }
}

function normaliseSignature(header: string | string[] | undefined): string | null {
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  if (Array.isArray(header)) {
    const first = header.find(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    return first ?? null;
  }
  return null;
}

function parseSignatureHeader(
  raw: string,
): { readonly timestamp: number; readonly v1: string } | null {
  // Format: `t=<unix>,v1=<hex>`. We tolerate whitespace and any
  // additional `vN=` future-versioned signatures.
  const parts = raw.split(',').map((part) => part.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    if (part.startsWith('t=')) {
      const value = part.slice(2);
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        t = parsed;
      }
    } else if (part.startsWith('v1=')) {
      const value = part.slice(3);
      if (/^[0-9a-f]+$/i.test(value)) {
        v1 = value;
      }
    }
  }
  if (t === null || v1 === null) return null;
  return { timestamp: t, v1 };
}

function projectEvent(payload: unknown): CheckrEventEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const id = typeof p['id'] === 'string' ? p['id'] : null;
  const type = typeof p['type'] === 'string' ? p['type'] : null;
  const accountId = typeof p['account_id'] === 'string' ? p['account_id'] : null;
  const createdAtRaw = p['created_at'];
  const data =
    typeof p['data'] === 'object' && p['data'] !== null
      ? (p['data'] as Record<string, unknown>)
      : null;
  if (id === null || type === null || accountId === null || data === null) {
    return null;
  }
  const object =
    typeof data['object'] === 'object' && data['object'] !== null
      ? (data['object'] as Record<string, unknown>)
      : null;
  if (object === null) return null;
  const objectId = typeof object['id'] === 'string' ? object['id'] : null;
  if (objectId === null) return null;
  // Checkr's `type` is dotted (e.g. `report.completed`); we project
  // the first segment as `object.kind` (`report`).
  const objectKind = type.split('.', 1)[0] ?? 'unknown';
  const status = typeof object['status'] === 'string' ? object['status'] : null;
  const candidateId = typeof object['candidate_id'] === 'string' ? object['candidate_id'] : null;
  const createdSeconds =
    typeof createdAtRaw === 'string'
      ? Math.floor(Date.parse(createdAtRaw) / 1000)
      : typeof createdAtRaw === 'number'
        ? Math.floor(createdAtRaw)
        : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(createdSeconds) || createdSeconds <= 0) {
    return null;
  }
  return {
    id,
    type,
    accountId,
    object: {
      id: objectId,
      kind: objectKind,
      status,
      candidateId,
    },
    createdSeconds,
  };
}
