import {
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
  type CertificationRenewalCandidate,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { buildReminderDispatch, formatExpiryDate } from './reminder-builder';

function candidate(
  overrides: Partial<CertificationRenewalCandidate> = {},
): CertificationRenewalCandidate {
  return {
    certificationId: 'cert_1',
    studentUserId: 'student_1',
    holderName: 'Jane Holder',
    courseId: 'course_1',
    courseTitle: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    issuedAt: '2024-06-08T12:00:00.000Z',
    expiresAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  };
}

describe('formatExpiryDate', () => {
  it('formats an ISO timestamp as a human UTC date', () => {
    expect(formatExpiryDate('2026-07-23T12:00:00.000Z')).toBe('July 23, 2026');
    expect(formatExpiryDate('2026-01-01T00:00:00.000Z')).toBe('January 1, 2026');
  });
});

describe('buildReminderDispatch', () => {
  it('builds a transactional email dispatch with the milestone idempotency key', () => {
    const body = buildReminderDispatch({
      candidate: candidate(),
      recipientEmail: 'jane@example.com',
      daysUntilExpiry: 60,
      milestoneDays: 60,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });

    expect(body).toMatchObject({
      recipientUserId: 'student_1',
      channel: 'email',
      category: 'transactional',
      templateCode: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
      locale: 'en-US',
      recipientAddress: 'jane@example.com',
      bypassQuietHours: false,
      idempotencyKey: 'cert-renewal:cert_1:60',
    });
  });

  it('renders every template variable from the candidate', () => {
    const body = buildReminderDispatch({
      candidate: candidate(),
      recipientEmail: 'jane@example.com',
      daysUntilExpiry: 60,
      milestoneDays: 60,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });

    expect(body.variables).toEqual({
      holderName: 'Jane Holder',
      courseTitle: 'Dementia-Sensitive Dining',
      trackLabel: 'Dementia-Sensitive Dining',
      expiresOn: 'July 23, 2026',
      daysUntilExpiry: 60,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });
  });

  it('substitutes a warm fallback when the holder name is null', () => {
    const body = buildReminderDispatch({
      candidate: candidate({ holderName: null }),
      recipientEmail: 'jane@example.com',
      daysUntilExpiry: 7,
      milestoneDays: 7,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });
    expect(body.variables?.['holderName']).toBe('there');
  });

  it('maps each track to its human label', () => {
    const general = buildReminderDispatch({
      candidate: candidate({ track: 'general' }),
      recipientEmail: 'x@example.com',
      daysUntilExpiry: 30,
      milestoneDays: 30,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });
    expect(general.variables?.['trackLabel']).toBe('General');

    const luxury = buildReminderDispatch({
      candidate: candidate({ track: 'luxury_in_home' }),
      recipientEmail: 'x@example.com',
      daysUntilExpiry: 30,
      milestoneDays: 30,
      renewUrl: 'https://academy.example.com/renewals',
      appName: 'Taste & See',
    });
    expect(luxury.variables?.['trackLabel']).toBe('Luxury In-Home Service');
  });
});
