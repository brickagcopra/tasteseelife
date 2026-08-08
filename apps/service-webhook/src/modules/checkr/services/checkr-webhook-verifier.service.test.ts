import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { CheckrWebhookVerifierService } from './checkr-webhook-verifier.service';

const SECRET = 'whsec_test_checkr_bbbbbbbbbbbbbb';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CHECKR_WEBHOOK_SECRET: SECRET,
    CHECKR_WEBHOOK_TOLERANCE_SECONDS: 300,
    ...overrides,
  } as unknown as Env;
}

function signedHeaderFor(rawBody: Buffer, timestampSeconds: number): string {
  const v1 = createHmac('sha256', SECRET)
    .update(`${timestampSeconds}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

function makeEventBody(overrides: Record<string, unknown> = {}): Buffer {
  const body = {
    id: 'evt_abc',
    type: 'report.completed',
    account_id: 'acc_xyz',
    created_at: '2026-05-11T12:00:00Z',
    data: {
      object: {
        id: 'rep_abc',
        status: 'clear',
        candidate_id: 'cand_abc',
      },
    },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(body), 'utf8');
}

describe('CheckrWebhookVerifierService.verify', () => {
  it('accepts a correctly-signed request within the tolerance window', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ts = Math.floor(Date.now() / 1000);
    const body = makeEventBody();
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: signedHeaderFor(body, ts),
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt_abc');
      expect(result.event.type).toBe('report.completed');
      expect(result.event.accountId).toBe('acc_xyz');
      expect(result.event.object.id).toBe('rep_abc');
      expect(result.event.object.status).toBe('clear');
      expect(result.event.object.candidateId).toBe('cand_abc');
      expect(result.event.object.kind).toBe('report');
    }
  });

  it('rejects a missing signature header', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const result = verifier.verify({
      rawBody: makeEventBody(),
      signatureHeader: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_signature_header');
    }
  });

  it('rejects a malformed signature header', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const result = verifier.verify({
      rawBody: makeEventBody(),
      signatureHeader: 'garbage',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_signature_header');
    }
  });

  it('rejects a wrong-signature request', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ts = Math.floor(Date.now() / 1000);
    const body = makeEventBody();
    const wrongV1 = 'a'.repeat(64);
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: `t=${ts},v1=${wrongV1}`,
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_signature');
    }
  });

  it('rejects a request whose timestamp is outside the tolerance window', () => {
    const verifier = new CheckrWebhookVerifierService(
      makeEnv({ CHECKR_WEBHOOK_TOLERANCE_SECONDS: 60 }),
    );
    const ts = Math.floor(Date.now() / 1000);
    const body = makeEventBody();
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: signedHeaderFor(body, ts - 120),
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('replay_outside_tolerance');
    }
  });

  it('rejects a body that is not valid JSON (even when signed correctly)', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ts = Math.floor(Date.now() / 1000);
    const body = Buffer.from('not json', 'utf8');
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: signedHeaderFor(body, ts),
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_payload_shape');
    }
  });

  it('rejects a body missing required envelope fields', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ts = Math.floor(Date.now() / 1000);
    // Missing `id`, `type`, etc.
    const body = Buffer.from(JSON.stringify({ data: { object: { id: 'rep_abc' } } }), 'utf8');
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: signedHeaderFor(body, ts),
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_payload_shape');
    }
  });

  it('throws when called with a non-Buffer rawBody (misuse — main.ts misconfigured)', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    expect(() =>
      verifier.verify({
        rawBody: 'string' as unknown as Buffer,
        signatureHeader: 't=1,v1=abc',
      }),
    ).toThrow(TypeError);
  });

  it('selects the first non-empty entry when the header arrives as an array', () => {
    const verifier = new CheckrWebhookVerifierService(makeEnv());
    const ts = Math.floor(Date.now() / 1000);
    const body = makeEventBody();
    const result = verifier.verify({
      rawBody: body,
      signatureHeader: ['', signedHeaderFor(body, ts)],
      now: new Date(ts * 1000),
    });
    expect(result.ok).toBe(true);
  });
});
