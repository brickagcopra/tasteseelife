/**
 * Audit resource kinds for the ads bounded context (the `resourceKind` column
 * on the audit row). Snake_case slugs matching the Prisma table names.
 */
export const ADS_AUDIT_RESOURCE = {
  campaign: 'ad_campaign',
  creative: 'ad_creative',
  slotSchedule: 'ad_slot_schedule',
} as const;
