import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CertificationsMetrics,
  certificationFailureOutcome,
  tierFailureOutcome,
  type ProviderCertificationOutcome,
  type ProviderTierOutcome,
} from './certifications-metrics';

/**
 * Cardinality-contract mappers (TS-052-followup-9). Both mappers are the
 * identity on the failure `reason` — each reason IS a bounded outcome
 * member — so a new failure reason can't silently widen the metric label
 * space: the call site fails to type-check if a reason escapes the bounded
 * union. Mirrors `submitApplicationOutcome` (TS-051-followup-7).
 */
describe('certificationFailureOutcome', () => {
  it.each<Exclude<ProviderCertificationOutcome, 'ok' | 'error'>>([
    'invalid_request',
    'provider_not_found',
    'certification_not_found',
    'already_active',
    'not_found',
    'already_revoked',
    'outbox_validation_failed',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    // The non-reason fields differ per variant; the mapper ignores them.
    expect(certificationFailureOutcome({ reason } as never)).toBe(reason);
  });
});

describe('tierFailureOutcome', () => {
  it.each<Exclude<ProviderTierOutcome, 'ok' | 'error'>>([
    'invalid_request',
    'provider_not_found',
    'outbox_validation_failed',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    expect(tierFailureOutcome({ reason } as never)).toBe(reason);
  });
});

/**
 * CertificationsMetrics instruments (TS-052-followup-9; CLAUDE.md §10). Init
 * a real MeterProvider, drive the recorder, assert the Prometheus exposition.
 * Mirrors the ApplicationsMetrics test shape.
 */
describe('CertificationsMetrics — Prometheus exposition', () => {
  let metrics: CertificationsMetrics;

  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
    metrics = new CertificationsMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a grant outcome + latency', async () => {
    metrics.recordGrant('ok', 0.012);
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_certifications_granted_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /provider_certification_grant_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts distinct grant outcomes separately', async () => {
    metrics.recordGrant('already_active', 0.001);
    metrics.recordGrant('provider_not_found', 0.001);
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_certifications_granted_total\{[^}]*outcome="already_active"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_certifications_granted_total\{[^}]*outcome="provider_not_found"[^}]*\} 1/,
    );
  });

  it('counts a revoke outcome + latency', async () => {
    metrics.recordRevoke('already_revoked', 0.003);
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_certifications_revoked_total\{[^}]*outcome="already_revoked"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_certification_revoke_duration_seconds_count\{[^}]*outcome="already_revoked"[^}]*\} 1/,
    );
  });

  it('records the evaluate latency by outcome and the applied transition', async () => {
    metrics.recordTierEvaluate('ok', 0.02, {
      from: 'basic',
      to: 'certified',
      reason: 'auto_evaluation',
    });
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_evaluate_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_tier_transitions_total\{[^}]*from="basic"[^}]*to="certified"[^}]*reason="auto_evaluation"[^}]*\} 1/,
    );
  });

  it('records an override transition with reason="admin_override"', async () => {
    metrics.recordTierOverride('ok', 0.02, {
      from: 'elite',
      to: 'basic',
      reason: 'admin_override',
    });
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_override_duration_seconds_count\{[^}]*outcome="ok"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_tier_transitions_total\{[^}]*from="elite"[^}]*to="basic"[^}]*reason="admin_override"[^}]*\} 1/,
    );
  });

  it('records evaluate latency without a transition on a no-op / failure path', async () => {
    metrics.recordTierEvaluate('provider_not_found', 0.001, null);
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_tier_evaluate_duration_seconds_count\{[^}]*outcome="provider_not_found"[^}]*\} 1/,
    );
    // No transition recorded → the transitions counter is absent for this run.
    expect(out).not.toMatch(/provider_tier_transitions_total/);
  });

  it('never leaks a providerId / actor id / note onto the scrape surface', async () => {
    metrics.recordGrant('ok', 0.01);
    metrics.recordTierEvaluate('ok', 0.01, {
      from: 'basic',
      to: 'certified',
      reason: 'auto_evaluation',
    });
    const out = await serializeMetrics();
    expect(out).not.toContain('prov_');
    expect(out).not.toContain('user_');
    expect(out).toMatch(/provider_certifications_granted_total/);
    expect(out).toMatch(/provider_tier_transitions_total/);
  });
});
