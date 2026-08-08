import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApplicationsMetrics,
  applyWebhookOutcome,
  normalizeCheckrEventTypeLabel,
  submitApplicationOutcome,
  type ProviderApplicationSubmitOutcome,
} from './applications-metrics';

/**
 * Cardinality-contract mappers (TS-051-followup-7). `submitApplicationOutcome`
 * is the identity on the failure `reason` (each reason IS a bounded outcome
 * member); `applyWebhookOutcome` folds the non-apply-path reasons into `error`.
 * These pin the metric label space so a new failure reason can't silently
 * widen cardinality — the call sites fail to type-check if a reason escapes
 * the bounded union.
 */
describe('submitApplicationOutcome', () => {
  it.each<ProviderApplicationSubmitOutcome>([
    'invalid_request',
    'already_applied',
    'record_not_found',
    'report_mismatch',
    'event_replay',
    'checkr_unavailable',
    'checkr_invalid_applicant',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    // `cause` only matters for checkr_unavailable; the mapper ignores it.
    expect(submitApplicationOutcome({ reason, cause: null } as never)).toBe(reason);
  });
});

describe('applyWebhookOutcome', () => {
  it('maps event_replay → replayed', () => {
    expect(applyWebhookOutcome({ reason: 'event_replay', eventId: 'e' })).toBe('replayed');
  });
  it('maps report_mismatch → report_mismatch', () => {
    expect(applyWebhookOutcome({ reason: 'report_mismatch', reportId: 'r' })).toBe(
      'report_mismatch',
    );
  });
  it('maps invalid_request → invalid_request', () => {
    expect(applyWebhookOutcome({ reason: 'invalid_request', message: 'm' })).toBe(
      'invalid_request',
    );
  });
  it.each(['record_not_found', 'checkr_unavailable', 'checkr_invalid_applicant'] as const)(
    'folds non-apply-path reason "%s" into error',
    (reason) => {
      expect(applyWebhookOutcome({ reason, message: 'm', cause: null } as never)).toBe('error');
    },
  );
});

describe('normalizeCheckrEventTypeLabel', () => {
  it('maps a known report.* type to its short label', () => {
    expect(normalizeCheckrEventTypeLabel('report.completed')).toBe('completed');
  });
  it('collapses an unknown / attacker-supplied type to "other"', () => {
    expect(normalizeCheckrEventTypeLabel('report.totally_made_up')).toBe('other');
    expect(normalizeCheckrEventTypeLabel('candidate.created')).toBe('other');
    expect(normalizeCheckrEventTypeLabel('')).toBe('other');
  });
});

/**
 * ApplicationsMetrics instruments (TS-051-followup-7; CLAUDE.md §10). Init a
 * real MeterProvider, drive the recorder, assert the Prometheus exposition.
 * Mirrors the KycMetrics test shape.
 */
describe('ApplicationsMetrics — Prometheus exposition', () => {
  let metrics: ApplicationsMetrics;

  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
    metrics = new ApplicationsMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a submission outcome', async () => {
    metrics.recordSubmitted('ok');
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_applications_submitted_total\{[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('counts distinct submission outcomes separately', async () => {
    metrics.recordSubmitted('already_applied');
    metrics.recordSubmitted('checkr_unavailable');
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_applications_submitted_total\{[^}]*outcome="already_applied"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_applications_submitted_total\{[^}]*outcome="checkr_unavailable"[^}]*\} 1/,
    );
  });

  it('counts a webhook-applied event with normalised event_type + outcome + latency', async () => {
    metrics.recordWebhookApplied('report.completed', 'applied', 0.012);
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_background_check_webhook_applied_total\{[^}]*event_type="completed"[^}]*outcome="applied"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_background_check_webhook_apply_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/,
    );
  });

  it('normalises an unknown event type to event_type="other" on the metric', async () => {
    metrics.recordWebhookApplied('report.made_up', 'report_mismatch', 0.001);
    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_background_check_webhook_applied_total\{[^}]*event_type="other"[^}]*outcome="report_mismatch"[^}]*\} 1/,
    );
  });

  it('never leaks a candidate / report id or payload onto the scrape surface', async () => {
    metrics.recordSubmitted('ok');
    metrics.recordWebhookApplied('report.completed', 'applied', 0.01);
    const out = await serializeMetrics();
    expect(out).not.toContain('cand_');
    expect(out).not.toContain('rep_');
    expect(out).toMatch(/provider_applications_submitted_total/);
    expect(out).toMatch(/provider_background_check_webhook_applied_total/);
  });
});
