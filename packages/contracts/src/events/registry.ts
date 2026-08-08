import type { z, ZodTypeAny } from 'zod';

import { AUDIT_ACTION_RECORDED, AuditActionRecordedSchema } from './audit';
import { CONTENT_PAGE_MATERIAL_CHANGED, ContentPageMaterialChangedSchema } from './content-legal';
import {
  CONTENT_NEWSLETTER_SEND_REQUESTED,
  ContentNewsletterSendRequestedSchema,
} from './content-newsletter';
import {
  CONTENT_ARTICLE_PUBLISHED,
  CONTENT_ARTICLE_UNPUBLISHED,
  ContentArticlePublishedSchema,
  ContentArticleUnpublishedSchema,
} from './content-search';
import {
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  IdentityEmailVerificationRequestedSchema,
} from './identity-account';
import {
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED,
  IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED,
  IDENTITY_ROLE_ASSIGNMENT_EXPIRED,
  IdentityRoleAssignmentApprovalDecidedSchema,
  IdentityRoleAssignmentApprovalRequestedSchema,
  IdentityRoleAssignmentExpiredSchema,
} from './identity-rbac';
import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_CREATED,
  BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
  BOOKING_ANOMALY_MASS_CANCELLATION,
  BOOKING_DECLINED,
  BOOKING_DISPUTE_OPENED,
  BOOKING_DISPUTE_RESOLVED,
  BOOKING_IN_PROGRESS,
  BOOKING_TIER_GATING_VIOLATION,
  BookingAnomalyImpossibleTravelSchema,
  BookingAnomalyMassCancellationSchema,
  BookingCanceledSchema,
  BookingCompletedSchema,
  BookingConfirmedSchema,
  BookingCreatedSchema,
  BookingDeclinedSchema,
  BookingDisputeOpenedSchema,
  BookingDisputeResolvedSchema,
  BookingInProgressSchema,
  BookingTierGatingViolationSchema,
} from './booking';
import {
  PROVIDER_AVAILABILITY_UPDATED,
  PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
  PROVIDER_CALENDAR_SYNCED,
  PROVIDER_CERTIFICATION_GRANTED,
  PROVIDER_CERTIFICATION_REVOKED,
  PROVIDER_PRICING_UPDATED,
  PROVIDER_PROFILE_UPDATED,
  PROVIDER_METRICS_UPDATED,
  PROVIDER_SERVICE_AREAS_UPDATED,
  PROVIDER_TIER_CHANGED,
  ProviderAvailabilityUpdatedSchema,
  ProviderBackgroundCheckAdverseFindingSchema,
  ProviderCalendarSyncedSchema,
  ProviderCertificationGrantedSchema,
  ProviderCertificationRevokedSchema,
  ProviderPricingUpdatedSchema,
  ProviderProfileUpdatedSchema,
  ProviderMetricsUpdatedSchema,
  ProviderServiceAreasUpdatedSchema,
  ProviderTierChangedSchema,
} from './provider';
import {
  SEARCH_PERFORMED,
  SEARCH_RESULT_CLICKED,
  SearchPerformedSchema,
  SearchResultClickedSchema,
} from './search';
import {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_SUBSCRIPTION_CHANGED,
  StripeInvoiceChangedSchema,
  StripePaymentMethodChangedSchema,
  StripeSubscriptionChangedSchema,
} from './stripe-billing';
import {
  SUBSCRIPTION_ACTIVATED,
  SUBSCRIPTION_CANCELED,
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAUSED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEEDED,
  SUBSCRIPTION_RESUMED,
  SubscriptionActivatedSchema,
  SubscriptionCanceledSchema,
  SubscriptionDunningExhaustedSchema,
  SubscriptionPausedSchema,
  SubscriptionPaymentFailedSchema,
  SubscriptionPaymentSucceededSchema,
  SubscriptionResumedSchema,
} from './subscription';
import {
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
  TRUST_SAFETY_INCIDENT_CREATED,
  TrustSafetyBookingHoldReleasedSchema,
  TrustSafetyBookingHoldRequestedSchema,
  TrustSafetyIncidentCreatedSchema,
} from './trust-safety';

/**
 * Event SDL — central registry of every domain event published on the
 * Taste & See event bus. Services consume the schemas here rather than
 * redefining shapes locally; that way a publisher edit is a TS error at
 * every consumer (compile-time drift detection complementing the OpenAPI
 * artifact diff for HTTP DTOs).
 *
 * `as const satisfies Record<string, ZodTypeAny>` preserves the literal key
 * inference so `EventName` is the union of dotted event names and
 * `EventPayloadFor<N>` resolves to the specific Zod-inferred type.
 */
export const eventRegistry = {
  [SUBSCRIPTION_ACTIVATED]: SubscriptionActivatedSchema,
  [SUBSCRIPTION_CANCELED]: SubscriptionCanceledSchema,
  [SUBSCRIPTION_PAYMENT_FAILED]: SubscriptionPaymentFailedSchema,
  [SUBSCRIPTION_PAYMENT_SUCCEEDED]: SubscriptionPaymentSucceededSchema,
  [SUBSCRIPTION_DUNNING_EXHAUSTED]: SubscriptionDunningExhaustedSchema,
  [SUBSCRIPTION_PAUSED]: SubscriptionPausedSchema,
  [SUBSCRIPTION_RESUMED]: SubscriptionResumedSchema,
  [BOOKING_CREATED]: BookingCreatedSchema,
  [BOOKING_CONFIRMED]: BookingConfirmedSchema,
  [BOOKING_IN_PROGRESS]: BookingInProgressSchema,
  [BOOKING_COMPLETED]: BookingCompletedSchema,
  [BOOKING_CANCELED]: BookingCanceledSchema,
  [BOOKING_DECLINED]: BookingDeclinedSchema,
  [BOOKING_DISPUTE_OPENED]: BookingDisputeOpenedSchema,
  [BOOKING_DISPUTE_RESOLVED]: BookingDisputeResolvedSchema,
  [BOOKING_TIER_GATING_VIOLATION]: BookingTierGatingViolationSchema,
  [BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL]: BookingAnomalyImpossibleTravelSchema,
  [BOOKING_ANOMALY_MASS_CANCELLATION]: BookingAnomalyMassCancellationSchema,
  [PROVIDER_CERTIFICATION_GRANTED]: ProviderCertificationGrantedSchema,
  [PROVIDER_CERTIFICATION_REVOKED]: ProviderCertificationRevokedSchema,
  [PROVIDER_TIER_CHANGED]: ProviderTierChangedSchema,
  [PROVIDER_PROFILE_UPDATED]: ProviderProfileUpdatedSchema,
  [PROVIDER_AVAILABILITY_UPDATED]: ProviderAvailabilityUpdatedSchema,
  [PROVIDER_SERVICE_AREAS_UPDATED]: ProviderServiceAreasUpdatedSchema,
  [PROVIDER_METRICS_UPDATED]: ProviderMetricsUpdatedSchema,
  [PROVIDER_PRICING_UPDATED]: ProviderPricingUpdatedSchema,
  [PROVIDER_CALENDAR_SYNCED]: ProviderCalendarSyncedSchema,
  [PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING]: ProviderBackgroundCheckAdverseFindingSchema,
  [SEARCH_PERFORMED]: SearchPerformedSchema,
  [SEARCH_RESULT_CLICKED]: SearchResultClickedSchema,
  [AUDIT_ACTION_RECORDED]: AuditActionRecordedSchema,
  [CONTENT_PAGE_MATERIAL_CHANGED]: ContentPageMaterialChangedSchema,
  [CONTENT_ARTICLE_PUBLISHED]: ContentArticlePublishedSchema,
  [CONTENT_ARTICLE_UNPUBLISHED]: ContentArticleUnpublishedSchema,
  [CONTENT_NEWSLETTER_SEND_REQUESTED]: ContentNewsletterSendRequestedSchema,
  [IDENTITY_EMAIL_VERIFICATION_REQUESTED]: IdentityEmailVerificationRequestedSchema,
  [IDENTITY_ROLE_ASSIGNMENT_EXPIRED]: IdentityRoleAssignmentExpiredSchema,
  [IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED]: IdentityRoleAssignmentApprovalRequestedSchema,
  [IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED]: IdentityRoleAssignmentApprovalDecidedSchema,
  [TRUST_SAFETY_INCIDENT_CREATED]: TrustSafetyIncidentCreatedSchema,
  [TRUST_SAFETY_BOOKING_HOLD_REQUESTED]: TrustSafetyBookingHoldRequestedSchema,
  [TRUST_SAFETY_BOOKING_HOLD_RELEASED]: TrustSafetyBookingHoldReleasedSchema,
  [STRIPE_SUBSCRIPTION_CHANGED]: StripeSubscriptionChangedSchema,
  [STRIPE_INVOICE_CHANGED]: StripeInvoiceChangedSchema,
  [STRIPE_PAYMENT_METHOD_CHANGED]: StripePaymentMethodChangedSchema,
} as const satisfies Record<string, ZodTypeAny>;

export type EventName = keyof typeof eventRegistry;
export type EventSchema<N extends EventName> = (typeof eventRegistry)[N];
export type EventPayloadFor<N extends EventName> = z.infer<EventSchema<N>>;

/**
 * Look up the Zod schema for an event by name. Returns the schema (typed),
 * or `undefined` for an unknown name — callers at the bus boundary should
 * reject unknown events rather than silently dropping them.
 */
export function getEventSchema<N extends EventName>(name: N): EventSchema<N>;
export function getEventSchema(name: string): ZodTypeAny | undefined;
export function getEventSchema(name: string): ZodTypeAny | undefined {
  return (eventRegistry as Record<string, ZodTypeAny>)[name];
}
