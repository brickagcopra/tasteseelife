import {
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CATEGORY,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_LOCALE,
  type AcademyCertificationRenewalThresholdDays,
  type AcademyCourseTrack,
  type CertificationRenewalCandidate,
  type DispatchNotificationRequest,
} from '@taste-and-see/contracts';

/**
 * Pure builder turning one renewal candidate + its resolved recipient into
 * a `DispatchNotificationRequest` for service-notification (TS-256). No IO
 * / NestJS so it is trivially unit-tested.
 *
 * The idempotency key is `cert-renewal:{certificationId}:{milestoneDays}`
 * so each milestone (90 / 60 / 30 / 7) sends exactly once per
 * certification even though the worker scans daily — a re-scan replays the
 * dispatch row rather than re-sending.
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Human labels per certification track (PRD §9.1 specialty tracks). */
const TRACK_LABELS: Record<AcademyCourseTrack, string> = {
  general: 'General',
  dementia_sensitive: 'Dementia-Sensitive Dining',
  therapeutic_meals: 'Therapeutic Meals',
  luxury_in_home: 'Luxury In-Home Service',
  cultural_comfort_cuisine: 'Cultural Comfort Cuisine',
};

/** Warm fallback when the certification carries no snapshotted holder name. */
const HOLDER_NAME_FALLBACK = 'there';

/** Format an ISO timestamp as a human UTC date, e.g. "June 8, 2026". */
export function formatExpiryDate(expiresAtIso: string): string {
  const date = new Date(expiresAtIso);
  const monthName = MONTH_NAMES[date.getUTCMonth()] ?? '';
  return `${monthName} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export interface BuildReminderInput {
  readonly candidate: CertificationRenewalCandidate;
  readonly recipientEmail: string;
  readonly daysUntilExpiry: number;
  readonly milestoneDays: AcademyCertificationRenewalThresholdDays;
  readonly renewUrl: string;
  readonly appName: string;
}

export function buildReminderDispatch(input: BuildReminderInput): DispatchNotificationRequest {
  const { candidate, recipientEmail, daysUntilExpiry, milestoneDays, renewUrl, appName } = input;

  return {
    recipientUserId: candidate.studentUserId,
    channel: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL,
    category: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CATEGORY,
    templateCode: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
    locale: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_LOCALE,
    recipientAddress: recipientEmail,
    variables: {
      holderName: candidate.holderName ?? HOLDER_NAME_FALLBACK,
      courseTitle: candidate.courseTitle,
      trackLabel: TRACK_LABELS[candidate.track],
      expiresOn: formatExpiryDate(candidate.expiresAt),
      daysUntilExpiry,
      renewUrl,
      appName,
    },
    bypassQuietHours: false,
    idempotencyKey: `cert-renewal:${candidate.certificationId}:${milestoneDays}`,
  };
}
