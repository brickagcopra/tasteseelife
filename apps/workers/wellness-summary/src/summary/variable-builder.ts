import {
  WELLNESS_SUMMARY_TEMPLATE_CATEGORY,
  WELLNESS_SUMMARY_TEMPLATE_CHANNEL,
  WELLNESS_SUMMARY_TEMPLATE_CODE,
  WELLNESS_SUMMARY_TEMPLATE_LOCALE,
  type DispatchNotificationRequest,
  type InternalSeniorWellnessObservationSummaryResponse,
  type WellnessObservationMetricSummary,
  type WellnessSummaryRecipient,
  type WellnessSummarySenior,
  type WellnessTrendMetric,
} from '@taste-and-see/contracts';

/**
 * Build the per-(recipient × senior) dispatch request for the monthly
 * wellness summary (TS-235). Pure — no IO — so the consent gate + the
 * variable shape are unit-testable in isolation.
 *
 * **Consent gate (CLAUDE.md §12).** `detailShared` is true for the
 * account manager (`primary_payer`) and the senior themselves
 * (`senior_user`); for a `family_observer` it follows the senior's
 * `notes` consent flag. When detail is withheld, the four scale
 * summaries are passed as empty strings — the variables are still
 * present (render-time validation requires every declared variable),
 * and the template's `{{#if detailShared}}` block hides them.
 *
 * **Replay safety.** The idempotency key is deterministic per
 * `(period, senior, recipient)` so a re-run of the same monthly period
 * collapses against the original dispatch row.
 */

const MANAGER_ROLES: ReadonlySet<WellnessSummaryRecipient['role']> = new Set([
  'primary_payer',
  'senior_user',
]);

const METRIC_LABEL: Record<WellnessTrendMetric, string> = {
  mood: 'Mood',
  appetite: 'Appetite',
  hydration: 'Hydration',
  social_engagement: 'Social engagement',
};

export interface BuildDispatchArgs {
  readonly recipient: WellnessSummaryRecipient;
  readonly recipientEmail: string;
  readonly senior: WellnessSummarySenior;
  readonly observation: InternalSeniorWellnessObservationSummaryResponse;
  readonly periodKey: string;
  readonly periodLabel: string;
  readonly appName: string;
}

/** Whether this recipient may see the senior's observation detail. */
export function recipientMaySeeDetail(
  role: WellnessSummaryRecipient['role'],
  notesConsent: boolean,
): boolean {
  return MANAGER_ROLES.has(role) || notesConsent;
}

/** One-line roll-up for a scale, or empty when withheld. */
function metricSummary(metric: WellnessObservationMetricSummary, shared: boolean): string {
  if (!shared) return '';
  const label = METRIC_LABEL[metric.metric];
  if (metric.visitsRecorded === 0 || metric.averageScore === null) {
    return `${label}: not recorded this period.`;
  }
  const visits = metric.visitsRecorded === 1 ? '1 visit' : `${metric.visitsRecorded} visits`;
  return `${label}: ${metric.averageScore} / 5 on average across ${visits}.`;
}

function findMetric(
  metrics: readonly WellnessObservationMetricSummary[],
  metric: WellnessTrendMetric,
): WellnessObservationMetricSummary {
  return (
    metrics.find((m) => m.metric === metric) ?? {
      metric,
      latestScore: null,
      averageScore: null,
      visitsRecorded: 0,
    }
  );
}

export function buildDispatchRequest(args: BuildDispatchArgs): DispatchNotificationRequest {
  const detailShared = recipientMaySeeDetail(args.recipient.role, args.senior.notesConsent);
  const { metrics } = args.observation;

  const variables: Record<string, string | number | boolean> = {
    seniorName: args.senior.firstName,
    periodLabel: args.periodLabel,
    totalVisits: args.observation.totalCompletedVisits,
    detailShared,
    moodSummary: metricSummary(findMetric(metrics, 'mood'), detailShared),
    appetiteSummary: metricSummary(findMetric(metrics, 'appetite'), detailShared),
    hydrationSummary: metricSummary(findMetric(metrics, 'hydration'), detailShared),
    socialSummary: metricSummary(findMetric(metrics, 'social_engagement'), detailShared),
    appName: args.appName,
  };

  return {
    recipientUserId: args.recipient.userId,
    channel: WELLNESS_SUMMARY_TEMPLATE_CHANNEL,
    category: WELLNESS_SUMMARY_TEMPLATE_CATEGORY,
    templateCode: WELLNESS_SUMMARY_TEMPLATE_CODE,
    locale: WELLNESS_SUMMARY_TEMPLATE_LOCALE,
    recipientAddress: args.recipientEmail,
    variables,
    bypassQuietHours: false,
    idempotencyKey: `wellness-summary:${args.periodKey}:${args.senior.seniorId}:${args.recipient.userId}`,
  };
}
