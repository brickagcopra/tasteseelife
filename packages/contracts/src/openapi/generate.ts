import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  ActivityEventKindSchema,
  ActivityEventResponseSchema,
  ActivityEventsListResponseSchema,
  ListMyActivityQuerySchema,
  ListUserActivityQuerySchema,
  RecordActivityEventRequestSchema,
  RecordActivityEventResponseSchema,
} from '../http/activity.schema';
import {
  AdminAccountingCurrencySchema,
  AdminJournalDetailResponseSchema,
  AdminJournalDetailSchema,
  AdminJournalLineSchema,
  AdminJournalSummarySchema,
  AdminJournalsListQuerySchema,
  AdminJournalsListResponseSchema,
  AdminPausedDeferredRevenueBalanceSchema,
  AdminPausedDeferredRevenueQuerySchema,
  AdminPausedDeferredRevenueResponseSchema,
  AdminPausedDeferredRevenueSummarySchema,
  AdminPeriodEventSchema,
  AdminPeriodEventsListQuerySchema,
  AdminPeriodEventsListResponseSchema,
  AdminTrialBalanceQuerySchema,
  AdminTrialBalanceResponseSchema,
  AdminTrialBalanceRowSchema,
} from '../http/admin-accounting.schema';
import {
  AdminBookingCheckInSummarySchema,
  AdminBookingDetailResponseSchema,
  AdminBookingDetailSchema,
  AdminBookingDisputeSummarySchema,
  AdminBookingRecurrenceSummarySchema,
  AdminBookingSummarySchema,
  AdminBookingVisitNoteSummarySchema,
  AdminBookingsListQuerySchema,
  AdminBookingsListResponseSchema,
} from '../http/admin-bookings.schema';
import {
  AdminAccountActiveReasonSchema,
  AdminAccountActiveStateSnapshotSchema,
  UpdateAccountActiveRequestSchema,
  UpdateAccountActiveResponseSchema,
} from '../http/admin-chart-of-accounts.schema';
import {
  AdminSubscriptionDetailResponseSchema,
  AdminSubscriptionDetailSchema,
  AdminSubscriptionDunningSummarySchema,
  AdminSubscriptionHistoryEntrySchema,
  AdminSubscriptionPauseSummarySchema,
  AdminSubscriptionPaymentMethodSummarySchema,
  AdminSubscriptionPlanSummarySchema,
  AdminSubscriptionSummarySchema,
  AdminSubscriptionsListQuerySchema,
  AdminSubscriptionsListResponseSchema,
} from '../http/admin-subscriptions.schema';
import {
  AdminUserDetailResponseSchema,
  AdminUserDetailSchema,
  AdminUserKycSummarySchema,
  AdminUserLockoutSummarySchema,
  AdminUserMfaSummarySchema,
  AdminUserSummarySchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
} from '../http/admin-users.schema';
import {
  EndImpersonationRequestSchema,
  EndImpersonationResponseSchema,
  ImpersonateUserRequestSchema,
  ImpersonateUserResponseSchema,
} from '../http/admin-impersonation.schema';
import {
  AdminRbacCatalogExportResponseSchema,
  RbacCatalogPermissionSchema,
  RbacCatalogRoleSchema,
} from '../http/admin-rbac-catalog.schema';
import {
  AdminPermissionRecordSchema,
  AdminPermissionsListResponseSchema,
  AdminRoleRecordSchema,
  AdminRoleResponseSchema,
  AdminRolesListQuerySchema,
  AdminRolesListResponseSchema,
  ArchiveAdminRoleRequestSchema,
  CreateAdminRoleRequestSchema,
  UpdateAdminRoleRequestSchema,
} from '../http/admin-roles.schema';
import {
  AdminRoleApprovalRecordSchema,
  AdminRoleApprovalResponseSchema,
  AdminRoleApprovalsListQuerySchema,
  AdminRoleApprovalsListResponseSchema,
  DecideRoleApprovalRequestSchema,
  RequestRoleApprovalRequestSchema,
} from '../http/admin-role-approvals.schema';
import {
  AdminRoleAssignmentRecordSchema,
  AdminRoleAssignmentResponseSchema,
  AdminRoleAssignmentsListQuerySchema,
  AdminRoleAssignmentsListResponseSchema,
  BulkRoleAssignmentRowSchema,
  BulkRoleAssignmentsCommitRequestSchema,
  BulkRoleAssignmentsCommitResponseSchema,
  BulkRoleAssignmentsPreviewRequestSchema,
  BulkRoleAssignmentsPreviewResponseSchema,
  GrantRoleAssignmentRequestSchema,
  RevokeRoleAssignmentRequestSchema,
  RevokeRoleAssignmentResponseSchema,
} from '../http/admin-role-assignments.schema';
import {
  OrgSecurityPoliciesListResponseSchema,
  OrgSecurityPolicyRecordSchema,
  OrgSecurityPolicyResponseSchema,
  UpsertOrgSecurityPolicyRequestSchema,
} from '../http/org-security-policy.schema';
import {
  LoginChallengeResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LoginSessionResponseSchema,
  MfaConfirmRequestSchema,
  MfaConfirmResponseSchema,
  MfaEnrollRequestSchema,
  MfaEnrollResponseSchema,
  MfaListResponseSchema,
  MfaMethodKindSchema,
  MfaMethodSummarySchema,
  MfaRecoveryVerifyRequestSchema,
  MfaRemoveResponseSchema,
  MfaVerifyRequestSchema,
  RefreshResponseSchema,
  ResendVerificationEmailRequestSchema,
  ResendVerificationEmailResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  UserStatusSchema,
} from '../http/auth.schema';
import {
  BookingCheckInKindSchema,
  BookingCheckInResponseSchema,
  BookingCheckInsListResponseSchema,
  RecordBookingCheckInRequestSchema,
  RecordBookingCheckInResponseSchema,
} from '../http/booking-check-ins.schema';
import {
  BookingDisputeOpenedByRoleSchema,
  BookingDisputeReasonSchema,
  BookingDisputeResponseSchema,
  BookingDisputeStatusSchema,
  BookingDisputesListResponseSchema,
  OpenBookingDisputeRequestSchema,
  TransitionableBookingDisputeStatusSchema,
  UpdateBookingDisputeRequestSchema,
} from '../http/booking-disputes.schema';
import {
  DashboardPastVisitSchema,
  DashboardVisitNoteSummarySchema,
  FamilyVisitsDashboardQuerySchema,
  FamilyVisitsDashboardResponseSchema,
} from '../http/booking-dashboard.schema';
import {
  FamilyWellnessTrendsResponseSchema,
  WellnessTrendPointSchema,
  WellnessTrendSeriesSchema,
  WellnessTrendsQuerySchema,
  WellnessTrendsResponseSchema,
} from '../http/wellness-trends.schema';
import {
  FamilyWellnessAnomalyResponseSchema,
  WellnessAnomalyFlagSchema,
  WellnessAnomalyResponseSchema,
  WellnessAnomalySeveritySchema,
} from '../http/wellness-anomaly.schema';
import {
  BookingRecurrencePatternSchema,
  BookingRecurrenceRecordSchema,
  CreateRecurringBookingRequestSchema,
  CreateRecurringBookingResponseSchema,
} from '../http/booking-recurrence.schema';
import {
  HouseholdSubscriptionTierSchema,
  HouseholdTierSnapshotResponseSchema,
  ProviderTierSnapshotResponseSchema,
  ProviderTierSnapshotTierSchema,
  UpsertHouseholdTierSnapshotRequestSchema,
  UpsertProviderTierSnapshotRequestSchema,
} from '../http/booking-tier-snapshots.schema';
import {
  UpsertVisitNotesRequestSchema,
  VisitNoteAppetiteSchema,
  VisitNoteHydrationSchema,
  VisitNoteMoodSchema,
  VisitNoteSocialEngagementSchema,
  VisitNotesResponseSchema,
} from '../http/booking-visit-notes.schema';
import {
  MeResponseSchema,
  MeRoleAssignmentSchema,
  MeTenantScopeSchema,
} from '../http/gateway-me.schema';
import {
  IssueUploadUrlRequestSchema,
  IssueUploadUrlResponseSchema,
  ListMediaAssetsQuerySchema,
  MediaAssetEventKindSchema,
  MediaAssetKindSchema,
  MediaAssetResponseSchema,
  MediaAssetsListResponseSchema,
  MediaAssetStatusSchema,
  MediaOwnerScopeKindSchema,
  MediaScanStatusSchema,
  RecordAssetEventRequestSchema,
  RecordAssetEventResponseSchema,
  ResolveMediaAssetsQuerySchema,
  ResolveMediaAssetsResponseSchema,
  ResolvedMediaAssetSchema,
} from '../http/media.schema';
import {
  DispatchesListResponseSchema,
  DispatchNotificationRequestSchema,
  DispatchResponseSchema,
  ListDispatchesQuerySchema,
  NotificationCategorySchema,
  NotificationDispatchStatusSchema,
  NotificationSuppressionReasonSchema,
  PreferenceEntrySchema,
  QuietHoursWindowSchema,
  ResolvedPreferenceEntrySchema,
  UpsertPreferencesRequestSchema,
  UserPreferencesResponseSchema,
} from '../http/notification-dispatch.schema';
import {
  ActivateTemplateVersionRequestSchema,
  CreateTemplateRequestSchema,
  CreateTemplateVersionRequestSchema,
  ListTemplatesQuerySchema,
  NotificationChannelKindSchema,
  NotificationLocaleSchema,
  NotificationVariableEntrySchema,
  NotificationVariableTypeSchema,
  RenderTemplateRequestSchema,
  RenderTemplateResponseSchema,
  TemplateResponseSchema,
  TemplatesListResponseSchema,
  TemplateVersionResponseSchema,
  TemplateVersionsListResponseSchema,
} from '../http/notification.schema';
import { PlanSchema, PlansListResponseSchema } from '../http/plan.schema';
import {
  DeleteProviderDocumentResponseSchema,
  ProviderDiscoveryDocumentSchema,
  ProviderDiscoverySnapshotResponseSchema,
  ProviderDiscoverySortSchema,
  ProviderDiscoveryStatusSchema,
  ProviderDiscoveryTierSchema,
  SearchProvidersRequestSchema,
  SearchProvidersResponseSchema,
  UpsertProviderDocumentRequestSchema,
  UpsertProviderDocumentResponseSchema,
} from '../http/provider-discovery.schema';
import {
  RecordSearchClickRequestSchema,
  RecordSearchClickResponseSchema,
} from '../http/search-click.schema';
import {
  ProviderProfileRecordSchema,
  ProviderProfileTagKindSchema,
  UpdateProviderProfileRequestSchema,
  UpdateProviderProfileResponseSchema,
} from '../http/provider-profile.schema';
import {
  DeleteProviderAvailabilityResponseSchema,
  ProviderAvailabilityExceptionSchema,
  ProviderAvailabilityRecordSchema,
  ProviderAvailabilitySnapshotResponseSchema,
  ProviderAvailabilitySummaryEntrySchema,
  ProviderAvailabilitySummarySchema,
  ProviderAvailabilityWeekdaySchema,
  ProviderAvailabilityWindowSchema,
  UpdateProviderAvailabilityRequestSchema,
  UpdateProviderAvailabilityResponseSchema,
} from '../http/provider-availability.schema';
import {
  DeleteProviderServiceAreasResponseSchema,
  GeoBoundingBoxSchema,
  GeoCentroidSchema,
  GeoPolygonSchema,
  ProviderServiceAreaInputSchema,
  ProviderServiceAreaRecordSchema,
  ProviderServiceAreasSnapshotResponseSchema,
  UpdateProviderServiceAreasRequestSchema,
  UpdateProviderServiceAreasResponseSchema,
} from '../http/provider-service-area.schema';
import {
  ProviderPricingBandSchema,
  ProviderPricingRecordSchema,
  ProviderPricingSnapshotResponseSchema,
  UpdateProviderPricingRequestSchema,
  UpdateProviderPricingResponseSchema,
} from '../http/provider-pricing.schema';
import {
  DisconnectProviderCalendarResponseSchema,
  ProviderCalendarConnectionRecordSchema,
  ProviderCalendarConnectionSnapshotResponseSchema,
  ProviderCalendarConnectionStatusSchema,
  ProviderCalendarProviderSchema,
  StartProviderCalendarConnectionResponseSchema,
  SyncProviderCalendarResponseSchema,
} from '../http/provider-calendar-sync.schema';
import {
  ServiceCatalogListResponseSchema,
  ServiceCatalogRecordSchema,
  UpsertServiceCatalogEntryRequestSchema,
  UpsertServiceCatalogEntryResponseSchema,
} from '../http/service-catalog.schema';
import {
  DeleteSearchRankingConfigResponseSchema,
  GetSearchRankingConfigResponseSchema,
  ListSearchRankingConfigResponseSchema,
  SearchRankingConfigSchema,
  UpsertSearchRankingConfigRequestSchema,
  UpsertSearchRankingConfigResponseSchema,
} from '../http/search-ranking-config.schema';
import {
  DeleteFeaturedPlacementResponseSchema,
  FeaturedPlacementRecordSchema,
  FeaturedPlacementsListResponseSchema,
  ScheduleFeaturedPlacementRequestSchema,
  ScheduleFeaturedPlacementResponseSchema,
} from '../http/featured-placement.schema';
import {
  RecommendProvidersRequestSchema,
  RecommendProvidersResponseSchema,
  RecommendationSeniorProfileSchema,
  RecommendationSignalSchema,
  RecommendedProviderSchema,
  SeniorRecommendedProvidersResponseSchema,
} from '../http/provider-recommendation.schema';
import {
  CreateSavedSearchRequestSchema,
  DeleteSavedSearchResponseSchema,
  GetSavedSearchResponseSchema,
  RunSavedSearchResponseSchema,
  SavedSearchSchema,
  SavedSearchesListResponseSchema,
  UpdateSavedSearchRequestSchema,
} from '../http/saved-search.schema';
import {
  CreateFavoriteProviderRequestSchema,
  CreateFavoriteProviderResponseSchema,
  DeleteFavoriteProviderResponseSchema,
  FavoriteProviderSchema,
  FavoriteProvidersListResponseSchema,
} from '../http/favorite-provider.schema';
import {
  ConciergeAssignmentRecordSchema,
  ConciergeAssignmentSnapshotResponseSchema,
  ConciergeAssignmentsListResponseSchema,
  CreateConciergeAssignmentRequestSchema,
  CreateConciergeAssignmentResponseSchema,
  EndConciergeAssignmentResponseSchema,
} from '../http/concierge-assignment.schema';
import {
  AddThreadParticipantRequestSchema,
  AddThreadParticipantResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  RemoveThreadParticipantResponseSchema,
  ThreadDetailResponseSchema,
  ThreadParticipantRecordSchema,
  ThreadRecordSchema,
  ThreadWithParticipantsRecordSchema,
  ThreadsInboxResponseSchema,
} from '../http/messaging-thread.schema';
import {
  ConciergeTicketRecordSchema,
  ConciergeTicketsListResponseSchema,
  SubmitConciergeRequestRequestSchema,
  SubmitConciergeRequestResponseSchema,
} from '../http/concierge-ticket.schema';
import {
  AddConciergeTicketNoteRequestSchema,
  AddConciergeTicketNoteResponseSchema,
  ConciergeOpsTicketDetailResponseSchema,
  ConciergeOpsTicketsListResponseSchema,
  ConciergeTicketNoteRecordSchema,
  EscalateConciergeTicketRequestSchema,
  EscalateConciergeTicketResponseSchema,
  TransitionConciergeTicketRequestSchema,
  TransitionConciergeTicketResponseSchema,
} from '../http/concierge-ops.schema';
import {
  TriggerEmergencyAssistanceRequestSchema,
  TriggerEmergencyAssistanceResponseSchema,
} from '../http/concierge-emergency.schema';
import {
  ReportConcernReceiptSchema,
  AdminReportConcernRequestSchema,
  ReportConcernRequestSchema,
  ReportConcernResponseSchema,
  ListTrustSafetyIncidentsQuerySchema,
  TrustSafetyIncidentListResponseSchema,
  TrustSafetyIncidentRecordSchema,
  TrustSafetyIncidentResponseSchema,
  TrustSafetyIncidentSummarySchema,
} from '../http/trust-safety-incident.schema';
import {
  ProviderDossierBackgroundCheckSchema,
  ProviderDossierCoreSchema,
  ProviderDossierResponseSchema,
} from '../http/provider-dossier.schema';
import {
  Provider360IncidentsSectionSchema,
  Provider360ResponseSchema,
} from '../http/provider-360.schema';
import {
  ProviderMetricsCountsSchema,
  ProviderMetricsSectionSchema,
  ProviderMetricsWindowSchema,
} from '../http/provider-metrics.schema';
import {
  AdvanceMandatedReporterCaseRequestSchema,
  ListMandatedReporterCasesQuerySchema,
  MandatedReporterCaseListResponseSchema,
  MandatedReporterCaseRecordSchema,
  MandatedReporterCaseResponseSchema,
  MandatedReporterCaseSummarySchema,
  MandatedReporterJurisdictionListResponseSchema,
  MandatedReporterJurisdictionRecordSchema,
  MandatedReporterJurisdictionResponseSchema,
  OpenMandatedReporterCaseRequestSchema,
  ResolveIncidentRequestSchema,
  ResolveIncidentResponseSchema,
  SetMandatedReporterJurisdictionVerificationRequestSchema,
  UpsertMandatedReporterJurisdictionRequestSchema,
} from '../http/trust-safety-mandated-reporter.schema';
import {
  ConciergeScheduledEventRecordSchema,
  ConciergeScheduledEventsListResponseSchema,
  ScheduleConciergeEventRequestSchema,
  ScheduleConciergeEventResponseSchema,
  UpdateConciergeEventRequestSchema,
  UpdateConciergeEventResponseSchema,
} from '../http/concierge-scheduled-event.schema';
import {
  ConciergeRideStatusWebhookEventSchema,
  ConciergeRideStatusWebhookResponseSchema,
  ConciergeTransportationListResponseSchema,
  ConciergeTransportationRequestRecordSchema,
  ScheduleConciergeTransportationRequestSchema,
  ScheduleConciergeTransportationResponseSchema,
  UpdateConciergeTransportationRequestSchema,
  UpdateConciergeTransportationResponseSchema,
} from '../http/concierge-transportation.schema';
import {
  ConciergeOnboardingDetailRecordSchema,
  ConciergeOnboardingRecordSchema,
  ConciergeOnboardingStepRecordSchema,
  ConciergeOnboardingsListResponseSchema,
  CreateConciergeOnboardingRequestSchema,
  CreateConciergeOnboardingResponseSchema,
  GetConciergeOnboardingResponseSchema,
  MyConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingRequestSchema,
  UpdateConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingStepRequestSchema,
  UpdateConciergeOnboardingStepResponseSchema,
} from '../http/concierge-onboarding.schema';
import {
  ConciergeEnrichmentSummariesListResponseSchema,
  ConciergeEnrichmentSummaryRecordSchema,
  CreateConciergeEnrichmentSummaryRequestSchema,
  CreateConciergeEnrichmentSummaryResponseSchema,
  GetConciergeEnrichmentSummaryResponseSchema,
  MyConciergeEnrichmentSummariesResponseSchema,
  MyConciergeEnrichmentSummaryResponseSchema,
  UpdateConciergeEnrichmentSummaryRequestSchema,
  UpdateConciergeEnrichmentSummaryResponseSchema,
} from '../http/concierge-enrichment-summary.schema';
import {
  HouseholdBillingContactSchema,
  HouseholdMembershipSchema,
  InternalHouseholdBillingContactsRequestSchema,
  InternalHouseholdBillingContactsResponseSchema,
  InternalHouseholdMembershipsResponseSchema,
} from '../http/household-membership.schema';
import {
  InternalProviderBillingContactsRequestSchema,
  InternalProviderBillingContactsResponseSchema,
  ProviderBillingContactSchema,
} from '../http/provider-billing-contact.schema';
import {
  InternalSeniorPrepSnapshotResponseSchema,
  VisitPrepChecklistBookingSchema,
  VisitPrepChecklistResponseSchema,
  VisitPrepChecklistSeniorSchema,
} from '../http/visit-prep-checklist.schema';
import {
  MySeniorStatusSchema,
  MySeniorSummarySchema,
  MySeniorsResponseSchema,
} from '../http/my-seniors.schema';
import {
  SeniorAlertPreferencesResponseSchema,
  SeniorAlertTypeSchema,
  SetSeniorAlertPreferencesRequestSchema,
} from '../http/senior-alert-preferences.schema';
import {
  SeniorConsentResponseSchema,
  SeniorConsentSurfaceSchema,
  SetSeniorConsentRequestSchema,
} from '../http/senior-consent.schema';
import {
  FamilySeniorPhotoGalleryResponseSchema,
  SeniorPhotoGalleryQuerySchema,
  SeniorPhotoGalleryResponseSchema,
  SeniorPhotoSchema,
} from '../http/senior-photos.schema';
import {
  InternalRecipientContactsRequestSchema,
  InternalRecipientContactsResponseSchema,
  InternalSeniorWellnessObservationSummaryResponseSchema,
  InternalWellnessSummaryHouseholdsResponseSchema,
  WellnessObservationMetricSummarySchema,
  WellnessSummaryHouseholdSchema,
} from '../http/wellness-summary.schema';
import {
  AcademyLessonRecordSchema,
  AcademyLessonResponseSchema,
  AcademyLessonsListResponseSchema,
  CreateAcademyLessonRequestSchema,
  UpdateAcademyLessonRequestSchema,
} from '../http/academy-lesson.schema';
import {
  AcademyCourseModuleRecordSchema,
  AcademyCourseModuleWithLessonsSchema,
  AcademyModuleResponseSchema,
  AcademyModulesListResponseSchema,
  CreateAcademyModuleRequestSchema,
  DeleteAcademyModuleResponseSchema,
  UpdateAcademyModuleRequestSchema,
} from '../http/academy-module.schema';
import {
  AcademyCourseDetailResponseSchema,
  AcademyCourseDetailSchema,
  AcademyCourseRecordSchema,
  AcademyCourseResponseSchema,
  AcademyCoursesListResponseSchema,
  CreateAcademyCourseRequestSchema,
  ListAcademyCoursesQuerySchema,
  UpdateAcademyCourseRequestSchema,
} from '../http/academy-course.schema';
import {
  AdCampaignDetailResponseSchema,
  AdCampaignRecordSchema,
  AdCampaignResponseSchema,
  AdCampaignsListResponseSchema,
  AdCreativeResponseSchema,
  CreateAdCampaignRequestSchema,
  ListAdCampaignsQuerySchema,
  UpdateAdCampaignRequestSchema,
  UpdateAdCreativeStatusRequestSchema,
} from '../http/ads-campaign.schema';
import {
  AdPlacementRecordSchema,
  AdPlacementsListResponseSchema,
  AdSlotScheduleRecordSchema,
  AdSlotScheduleResponseSchema,
  AdSlotSchedulesListResponseSchema,
  CreateAdSlotScheduleRequestSchema,
  ListAdSlotSchedulesQuerySchema,
  UpdateAdSlotScheduleRequestSchema,
} from '../http/ad-slot-schedule.schema';
import {
  AdAccessibilityReportSchema,
  AdCreativeReviewItemSchema,
  AdCreativeReviewRecordSchema,
  CreativeReviewDetailResponseSchema,
  CreativeReviewMutationResponseSchema,
  CreativeReviewQueueResponseSchema,
  ListCreativeReviewQueueQuerySchema,
  ReviewAdCreativeRequestSchema,
  UpdateAdCreativeAccessibilityRequestSchema,
} from '../http/ad-creative-review.schema';
import {
  AcademyCohortRecordSchema,
  AcademyCohortResponseSchema,
  AcademyCohortsListResponseSchema,
  CreateAcademyCohortRequestSchema,
  ListAcademyCohortsQuerySchema,
  UpdateAcademyCohortRequestSchema,
} from '../http/academy-cohort.schema';
import {
  AcademyQuizAuthoringResponseSchema,
  AcademyQuizAuthoringTreeSchema,
  AcademyQuizQuestionOptionRecordSchema,
  AcademyQuizQuestionRecordSchema,
  AcademyQuizQuestionResponseSchema,
  AcademyQuizRecordSchema,
  AcademyQuizResponseSchema,
  CreateAcademyQuizQuestionRequestSchema,
  CreateAcademyQuizRequestSchema,
  UpdateAcademyQuizQuestionRequestSchema,
  UpdateAcademyQuizRequestSchema,
} from '../http/academy-quiz.schema';
import {
  AcademyQuizAttemptDetailResponseSchema,
  AcademyQuizAttemptDetailSchema,
  AcademyQuizAttemptRecordSchema,
  AcademyQuizAttemptsListResponseSchema,
  GradedQuizAnswerSchema,
  PresentedQuizQuestionSchema,
  SubmitQuizAttemptRequestSchema,
} from '../http/academy-quiz-attempt.schema';
import {
  AcademyCertificationRecordSchema,
  AcademyCertificationResponseSchema,
  AcademyCertificationsListResponseSchema,
  IssueAcademyCertificationRequestSchema,
  ListAcademyCertificationsQuerySchema,
  PublicCertificationVerificationResponseSchema,
  PublicCertificationVerificationSchema,
  RevokeAcademyCertificationRequestSchema,
} from '../http/academy-certification.schema';
import {
  CertificationRenewalCandidateSchema,
  ExpireCertificationResponseSchema,
  InternalCertificationRenewalsQuerySchema,
  InternalCertificationRenewalsResponseSchema,
} from '../http/academy-certification-renewals.schema';
import {
  AdminDataSubjectRequestListResponseSchema,
  CreateDataSubjectRequestSchema,
  DataSubjectKindSchema,
  DataSubjectRequestKindSchema,
  DataSubjectRequestListResponseSchema,
  DataSubjectRequestReceiptResponseSchema,
  DataSubjectRequestReceiptSchema,
  DataSubjectRequestRecordSchema,
  DataSubjectRequestRefusalReasonSchema,
  DataSubjectRequestResponseSchema,
  DataSubjectRequestStatusSchema,
  ExtendDataSubjectRequestSchema,
  ListDataSubjectRequestsQuerySchema,
  RefuseDataSubjectRequestSchema,
  VerifyDataSubjectRequestSchema,
} from '../http/privacy-data-subject-request.schema';
import {
  BillingPortalSessionResponseSchema,
  CreateBillingPortalSessionRequestSchema,
} from '../http/billing-portal.schema';
import {
  MySubscriptionResponseSchema,
  MySubscriptionSummarySchema,
} from '../http/my-subscription.schema';
import {
  PrivacyExportSectionSchema,
  PrivacyExportSliceParamsSchema,
  PrivacyExportSliceSchema,
  PrivacyExportWithholdingSchema,
} from '../http/privacy-export-slice.schema';
import {
  ContentStatusSchema,
  CreatePageRequestSchema,
  CreatePageVersionRequestSchema,
  ListPagesQuerySchema,
  PageDetailResponseSchema,
  PageDetailSchema,
  PageRecordSchema,
  PageResponseSchema,
  PageVersionRecordSchema,
  PageVersionResponseSchema,
  PagesListResponseSchema,
  PublishPageVersionRequestSchema,
} from '../http/content-page.schema';
import {
  ArticleDetailResponseSchema,
  ArticleDetailSchema,
  ArticleRecordSchema,
  ArticleResponseSchema,
  ArticleSeoResponseSchema,
  ArticleSeoSchema,
  ArticleCommentsSchema,
  ArticleCommentsResponseSchema,
  UpdateArticleCommentsRequestSchema,
  ArticleVersionRecordSchema,
  ArticleVersionResponseSchema,
  ArticlesListResponseSchema,
  CreateArticleRequestSchema,
  CreateArticleVersionRequestSchema,
  ListArticlesQuerySchema,
  PublishArticleVersionRequestSchema,
  SendArticleNewsletterRequestSchema,
  SendArticleNewsletterResponseSchema,
  UpdateArticleRequestSchema,
  UpdateArticleSeoRequestSchema,
} from '../http/content-article.schema';
import {
  ListPublicBlogArticlesQuerySchema,
  PublicBlogArticleListItemSchema,
  PublicBlogArticleResponseSchema,
  PublicBlogArticleSchema,
  PublicBlogArticlesListResponseSchema,
} from '../http/content-public-blog.schema';
import {
  CreateHelpCategoryRequestSchema,
  HelpCategoriesListResponseSchema,
  HelpCategoryRecordSchema,
  HelpCategoryResponseSchema,
  ListHelpCategoriesQuerySchema,
  UpdateHelpCategoryRequestSchema,
} from '../http/content-help-category.schema';
import {
  ArticleAuthorSchema,
  ArticleAuthorsResponseSchema,
  ContentAuthorRecordSchema,
  ContentAuthorResponseSchema,
  ContentAuthorsListResponseSchema,
  CreateContentAuthorRequestSchema,
  ListContentAuthorsQuerySchema,
  SetArticleAuthorsRequestSchema,
  UpdateContentAuthorRequestSchema,
} from '../http/content-author.schema';
import {
  ArticleFeedbackResponseSchema,
  ArticleFeedbackSummarySchema,
  ListRelatedArticlesQuerySchema,
  RelatedArticleSchema,
  RelatedArticlesResponseSchema,
  SubmitArticleFeedbackRequestSchema,
} from '../http/content-feedback.schema';

extendZodWithOpenApi(z);

export interface OpenApiDocumentInfo {
  title: string;
  version: string;
  description?: string;
}

const DEFAULT_INFO: OpenApiDocumentInfo = {
  title: 'Taste & See Platform API',
  version: '0.0.0',
  description:
    'Public service contracts for the Taste & See platform. Generated from Zod schemas in @taste-and-see/contracts; never hand-edited (CLAUDE.md §2.3).',
};

/**
 * Build the OpenAPI 3.1 document covering every public HTTP DTO registered
 * in `@taste-and-see/contracts`.
 *
 * The function is deterministic: registration order, schema definitions,
 * and `JSON.stringify` indentation are stable, so the artifact at
 * `generated/openapi.json` only changes when a schema actually changes —
 * which is exactly the contract-drift signal the CI `check` script reads.
 */
export function generateOpenApiDocument(info: OpenApiDocumentInfo = DEFAULT_INFO): unknown {
  const registry = new OpenAPIRegistry();

  registry.register(
    'Plan',
    PlanSchema.openapi({
      description:
        'A subscription plan offered to families/seniors, providers, or Cooking Academy students. Prices are integer USD minor units; consumers MUST use Decimal math (CLAUDE.md §4.1, §17.6).',
    }),
  );

  registry.register(
    'PlansListResponse',
    PlansListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/plans`. Wrapped in `{ plans: [...] }` so the shape is forward-compatible with future pagination metadata and filter facets without a v1 break.',
    }),
  );

  registry.register(
    'UserStatus',
    UserStatusSchema.openapi({
      description:
        'Account lifecycle status reported by service-identity. Mirrors the `identity.user_status` Postgres enum.',
    }),
  );

  registry.register(
    'SignupRequest',
    SignupRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/signup`. Email is normalised to lower-case before persistence; phone is optional and must be E.164. Password is bcrypt-hashed at cost ≥ 12 server-side (CLAUDE.md §3.1, §3.3).',
    }),
  );

  registry.register(
    'SignupResponse',
    SignupResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/signup`. Returns the created account in `pending_verification` state — no session token is issued at signup; the client must subsequently call `/api/v1/auth/login` (TS-022).',
    }),
  );

  registry.register(
    'VerifyEmailRequest',
    VerifyEmailRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/verify-email` (TS-510). The single-use token is delivered by email; only its SHA-256 digest is stored server-side, so a database read cannot mint a working link.',
    }),
  );

  registry.register(
    'VerifyEmailResponse',
    VerifyEmailResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/verify-email`. Carries the resulting account status and no session — proving control of a mailbox is not proving knowledge of the password, so the client’s next step is an ordinary login. `status` is the full enum because verification records the mailbox fact without resurrecting a suspended or deactivated account.',
    }),
  );

  registry.register(
    'ResendVerificationEmailRequest',
    ResendVerificationEmailRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/verification-emails` (TS-510). Requests a fresh verification token for an address; outstanding tokens stay spendable so a link already in the user’s inbox keeps working.',
    }),
  );

  registry.register(
    'ResendVerificationEmailResponse',
    ResendVerificationEmailResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/verification-emails`. A fixed 202 acknowledgement returned for every accepted address — registered, unregistered, or already verified — so an unauthenticated endpoint cannot be used to enumerate accounts (CLAUDE.md §3.1).',
    }),
  );

  registry.register(
    'LoginRequest',
    LoginRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/login`. Email + password are verified against the bcrypt digest stored at signup. Failures funnel through a single generic 401 to avoid account-enumeration leakage (CLAUDE.md §3.1).',
    }),
  );

  registry.register(
    'LoginResponse',
    LoginResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/login`. The access token is a 15-minute HS256 JWT; the refresh token is set as an HttpOnly+Secure cookie by the controller (never in this body). Use `expiresIn` to schedule proactive refresh.',
    }),
  );

  registry.register(
    'RefreshResponse',
    RefreshResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/refresh`. Issues a new access token and rotates the refresh-token cookie as a side effect. Re-presentation of an already-rotated refresh token revokes the entire family per CLAUDE.md §3.1 reuse-detection rule.',
    }),
  );

  registry.register(
    'LoginSessionResponse',
    LoginSessionResponseSchema.openapi({
      description:
        "The `outcome: 'session'` branch of `LoginResponse`. Returned when the user has no MFA configured, or has just completed an MFA challenge via `/api/v1/auth/mfa/verify`.",
    }),
  );

  registry.register(
    'LoginChallengeResponse',
    LoginChallengeResponseSchema.openapi({
      description:
        "The `outcome: 'challenge'` branch of `LoginResponse`. Returned when the credentials are valid AND the user has at least one confirmed MFA method. The `challengeToken` is single-use and short-lived; echo it to `/api/v1/auth/mfa/verify` with a TOTP code to complete login.",
    }),
  );

  registry.register(
    'MfaMethodKind',
    MfaMethodKindSchema.openapi({
      description:
        'MFA method kind. Mirrors the `identity.mfa_method_kind` Prisma enum. `sms_backup` is reserved for TS-023-followup; clients should ignore unknown kinds for forward-compatibility.',
    }),
  );

  registry.register(
    'MfaEnrollRequest',
    MfaEnrollRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/mfa/totp/enroll`. Begins TOTP enrollment for the authenticated user; rejects with 409 if a confirmed method already exists.',
    }),
  );

  registry.register(
    'MfaEnrollResponse',
    MfaEnrollResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/mfa/totp/enroll`. The client renders `otpauthUrl` as a QR (or shows `secretBase32` as a fallback paste-target). The user then types the resulting code into `MfaConfirmRequest` to finalise enrollment.',
    }),
  );

  registry.register(
    'MfaConfirmRequest',
    MfaConfirmRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/mfa/totp/confirm`. The 6-digit `code` proves the user successfully scanned the QR; on success the method is marked confirmed and `users.mfa_enabled` flips true.',
    }),
  );

  registry.register(
    'MfaConfirmResponse',
    MfaConfirmResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/auth/mfa/totp/confirm`. Acknowledges enrollment AND returns the freshly minted one-time recovery codes (TS-023-followup-2) — the only moment they are sent in plaintext. The client must surface them to the user once; the server keeps only hashes.',
    }),
  );

  registry.register(
    'MfaRecoveryVerifyRequest',
    MfaRecoveryVerifyRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/mfa/recovery/verify`. Lost-device second step of the login flow: presents the single-use challenge token plus one recovery code in lieu of a TOTP code. The recovery code is normalised (uppercase, separators stripped) before matching, then consumed single-use.',
    }),
  );

  registry.register(
    'MfaVerifyRequest',
    MfaVerifyRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/auth/mfa/verify`. Second step of the login flow when MFA is enabled. The `challengeToken` is consumed single-use; replay returns 401.',
    }),
  );

  registry.register(
    'MfaMethodSummary',
    MfaMethodSummarySchema.openapi({
      description:
        'Method summary returned by `GET /api/v1/auth/mfa/methods`. Deliberately narrow — no secret material, no key-version metadata. `confirmedAt = null` indicates a started-but-not-finished enrollment.',
    }),
  );

  registry.register(
    'MfaListResponse',
    MfaListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/auth/mfa/methods`. Lists every non-soft-deleted MFA method registered to the authenticated user.',
    }),
  );

  registry.register(
    'MfaRemoveResponse',
    MfaRemoveResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/auth/mfa/methods/{id}`. If the removed method was the last confirmed one, `users.mfa_enabled` is also flipped false server-side.',
    }),
  );

  // Admin users surface (TS-126 Slice 1 / TS-126-followup-9). Read-only
  // admin tooling at `GET /api/v1/admin/users` + `GET /api/v1/admin/users/:id`.
  // Gated server-side by `SuperAdminRoleGuard`; the schemas themselves carry
  // no auth metadata — that's a controller-layer concern (CLAUDE.md §3.2).
  registry.register(
    'AdminUserMfaSummary',
    AdminUserMfaSummarySchema.openapi({
      description:
        'Confirmed MFA method summary on the admin user detail view. Drops secret material + key-version metadata (admin tooling never decrypts the TOTP secret).',
    }),
  );

  registry.register(
    'AdminUserKycSummary',
    AdminUserKycSummarySchema.openapi({
      description:
        'Latest KYC record snapshot on the admin user detail view. Slice 1 omits the encrypted Stripe payload — full document review lands in TS-126-followup-3.',
    }),
  );

  registry.register(
    'AdminUserLockoutSummary',
    AdminUserLockoutSummarySchema.openapi({
      description:
        'Per-user lockout snapshot (TS-025). Carries the policy column (`lockedUntil`) plus the derived `currentlyLocked` flag so the UI does not re-compute the comparison.',
    }),
  );

  registry.register(
    'AdminUserSummary',
    AdminUserSummarySchema.openapi({
      description:
        'Row shape for `GET /api/v1/admin/users`. Denormalised summary (active role count, admin-role flag, lockout indicator) so the list page renders without an N+1 fetch.',
    }),
  );

  registry.register(
    'AdminUsersListQuery',
    AdminUsersListQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/users`. Cursor-paginated; `limit` defaults to 25 and is capped at 100. `roleName` filters to users with an ACTIVE assignment of the named role.',
    }),
  );

  registry.register(
    'AdminUsersListResponse',
    AdminUsersListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/users`. `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  registry.register(
    'AdminUserDetail',
    AdminUserDetailSchema.openapi({
      description:
        'Account detail shape for `GET /api/v1/admin/users/:id`. Carries the user record plus active role assignments, confirmed MFA methods, the most-recent KYC record, and lockout state. Slice 1 omits revoked / expired role assignments — full history lands with the RBAC admin tooling (TS-290).',
    }),
  );

  registry.register(
    'AdminUserDetailResponse',
    AdminUserDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/users/:id`. Wrapped in `{ user: ... }` so the shape is forward-compatible with future side-data (audit timeline, related accounts) without a v1 break.',
    }),
  );

  // Admin RBAC role-catalog surface (TS-290; PRD §10.12; PDD §10.3).
  // Role-DEFINITION management at /api/v1/admin/roles (+ the read-only
  // permission catalog at /api/v1/admin/permissions). Gated rbac:read /
  // rbac:write; system roles are read-only server-side.
  registry.register(
    'AdminPermissionRecord',
    AdminPermissionRecordSchema.openapi({
      description:
        'One catalog permission (resource + action + operator-facing description). The canonical `resource:action` string is derived, not duplicated on the wire.',
    }),
  );

  registry.register(
    'AdminPermissionsListResponse',
    AdminPermissionsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/permissions`. Flat + bounded; grouping by resource is a UI concern (TS-291 picker).',
    }),
  );

  registry.register(
    'AdminRoleRecord',
    AdminRoleRecordSchema.openapi({
      description:
        'One role with its `resource:action` permission strings inline (sorted server-side). `isSystem: true` rows are seed-owned and read-only; `archivedAt` non-null means hidden from assignment surfaces.',
    }),
  );

  registry.register(
    'RbacCatalogPermission',
    RbacCatalogPermissionSchema.openapi({
      description:
        'One portable permission definition in the RBAC catalog envelope (TS-299) — identified by the canonical `(resource, action)` pair, no surrogate ids.',
    }),
  );

  registry.register(
    'RbacCatalogRole',
    RbacCatalogRoleSchema.openapi({
      description:
        'One portable role definition in the RBAC catalog envelope (TS-299) — identified by `name`, permissions inline as sorted `resource:action` strings. `isSystem` is informational on export and never import-driven.',
    }),
  );

  registry.register(
    'AdminRbacCatalogExportResponse',
    AdminRbacCatalogExportResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/rbac-catalog/export` — the versioned, id-free RBAC catalog envelope. The body is directly importable via the `rbac:catalog` CLI (import is deliberately CLI-only).',
    }),
  );

  registry.register(
    'AdminRolesListQuery',
    AdminRolesListQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/admin/roles`. `includeArchived` opts archived rows in; the default list is live roles only.',
    }),
  );

  registry.register(
    'AdminRolesListResponse',
    AdminRolesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/roles`. Single bounded page — the role catalog is operator-curated and small.',
    }),
  );

  registry.register(
    'AdminRoleResponse',
    AdminRoleResponseSchema.openapi({
      description: 'Role envelope (`{ role }`) returned by detail, create, update, and archive.',
    }),
  );

  registry.register(
    'CreateAdminRoleRequest',
    CreateAdminRoleRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/roles`. Creates a CUSTOM role — `isSystem` is not accepted on the wire. Unknown permission strings are rejected with a 400 naming the offenders.',
    }),
  );

  registry.register(
    'UpdateAdminRoleRequest',
    UpdateAdminRoleRequestSchema.openapi({
      description:
        'Body for `PATCH /api/v1/admin/roles/:roleId`. Partial: omitted fields untouched, `description: null` clears, `permissions` replaces the whole set atomically. 409 for system or archived roles.',
    }),
  );

  registry.register(
    'ArchiveAdminRoleRequest',
    ArchiveAdminRoleRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/roles/:roleId/archive`. Optional audit `note`. Already-archived and system roles are 409.',
    }),
  );

  // Admin RBAC role-ASSIGNMENT surface (TS-292; PRD §10.12; PDD §10.3).
  // Grant / revoke over /api/v1/admin/role-assignments plus the CSV
  // bulk-preview / bulk-commit workflow. Gated rbac:read / rbac:write;
  // sensitive roles (super_admin, finance) take the TS-294 approval
  // flow and are rejected here.
  registry.register(
    'AdminRoleAssignmentRecord',
    AdminRoleAssignmentRecordSchema.openapi({
      description:
        'One role assignment held by a user. `active` is the server-time snapshot (not revoked, not expired); inactive rows only appear when `includeInactive` was requested.',
    }),
  );

  registry.register(
    'AdminRoleAssignmentsListQuery',
    AdminRoleAssignmentsListQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/admin/users/:userId/role-assignments`. `includeInactive` opts revoked / expired rows in.',
    }),
  );

  registry.register(
    'AdminRoleAssignmentsListResponse',
    AdminRoleAssignmentsListResponseSchema.openapi({
      description: 'Response body for the per-user assignment list. Single bounded page.',
    }),
  );

  registry.register(
    'AdminRoleAssignmentResponse',
    AdminRoleAssignmentResponseSchema.openapi({
      description: 'Assignment envelope (`{ assignment }`) returned by the single grant.',
    }),
  );

  registry.register(
    'GrantRoleAssignmentRequest',
    GrantRoleAssignmentRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/role-assignments`. Sensitive roles (super_admin, finance) are 403 (reviewer-approval flow, TS-294); archived roles and duplicate active assignments are 409. `expiresAt` must be in the future (enforced server-side).',
    }),
  );

  registry.register(
    'RevokeRoleAssignmentRequest',
    RevokeRoleAssignmentRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/role-assignments/:id/revoke`. Optional audit `reason`.',
    }),
  );

  registry.register(
    'RevokeRoleAssignmentResponse',
    RevokeRoleAssignmentResponseSchema.openapi({
      description:
        'Revoke result. `revoked: false` means the row was already revoked — idempotent, not an error.',
    }),
  );

  registry.register(
    'BulkRoleAssignmentRow',
    BulkRoleAssignmentRowSchema.openapi({
      description:
        'One parsed CSV row `(userId, roleName, scopeType, scopeId, expiresAt)`. Fields are loose-but-bounded — semantic validation happens per-row server-side so a bad cell yields a row verdict, not a batch 400.',
    }),
  );

  registry.register(
    'BulkRoleAssignmentsPreviewRequest',
    BulkRoleAssignmentsPreviewRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/role-assignments/bulk-preview` — read-only per-row validation of a parsed CSV batch. No writes.',
    }),
  );

  registry.register(
    'BulkRoleAssignmentsPreviewResponse',
    BulkRoleAssignmentsPreviewResponseSchema.openapi({
      description:
        'Per-row verdicts for a bulk preview. Ok rows carry the normalized grant that bulk-commit will apply.',
    }),
  );

  registry.register(
    'BulkRoleAssignmentsCommitRequest',
    BulkRoleAssignmentsCommitRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/role-assignments/bulk-commit`. Applied row-by-row with partial-success semantics — a failed row never rolls back a prior one.',
    }),
  );

  registry.register(
    'BulkRoleAssignmentsCommitResponse',
    BulkRoleAssignmentsCommitResponseSchema.openapi({
      description:
        'Per-row commit outcomes: `granted` (with assignment id), `conflict` (identical active assignment already existed), or `error` (rejection detail).',
    }),
  );

  // Admin RBAC role-APPROVAL surface (TS-294; CLAUDE.md §3.2; PDD §10.3).
  // Reviewer-required grant flow for sensitive roles over
  // /api/v1/admin/role-approvals. The requester cannot approve their own
  // request; approve additionally requires the approver to hold
  // super_admin (service-enforced).
  registry.register(
    'AdminRoleApprovalRecord',
    AdminRoleApprovalRecordSchema.openapi({
      description:
        'One sensitive-role grant request. `approvedByUserId` is the decider for both approve and reject; `userRoleId` is the assignment minted on approval (null otherwise).',
    }),
  );

  registry.register(
    'RequestRoleApprovalRequest',
    RequestRoleApprovalRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/role-approvals`. `reason` is REQUIRED (privilege escalation carries a why). Non-sensitive roles are 400 (use the direct grant); duplicate pending requests and already-held roles are 409.',
    }),
  );

  registry.register(
    'AdminRoleApprovalsListQuery',
    AdminRoleApprovalsListQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/admin/role-approvals`. `status=pending` is the reviewer queue; omitting `status` returns all (bounded).',
    }),
  );

  registry.register(
    'AdminRoleApprovalsListResponse',
    AdminRoleApprovalsListResponseSchema.openapi({
      description: 'Response body for the approvals list. Single bounded page, oldest first.',
    }),
  );

  registry.register(
    'AdminRoleApprovalResponse',
    AdminRoleApprovalResponseSchema.openapi({
      description: 'Approval envelope (`{ approval }`) returned by request / approve / reject.',
    }),
  );

  // Org security-policy surface (TS-296; CLAUDE.md §3.1; PDD §10.1).
  // Security flags keyed by tenant scope id (or the 'global' sentinel)
  // over /api/v1/admin/org-security-policies. `ssoRequired: true`
  // makes identity refuse non-SSO-asserted admin logins for that
  // scope with 403 `code: 'sso_assertion_required'`.
  registry.register(
    'OrgSecurityPolicyRecord',
    OrgSecurityPolicyRecordSchema.openapi({
      description:
        "One org security-policy row, keyed by tenant scope id or the 'global' sentinel (which governs global-scoped admin staff). An absent row means no policy — all flags default-off.",
    }),
  );

  registry.register(
    'OrgSecurityPoliciesListResponse',
    OrgSecurityPoliciesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/org-security-policies`. Single bounded page — the table is operator-curated and small.',
    }),
  );

  registry.register(
    'UpsertOrgSecurityPolicyRequest',
    UpsertOrgSecurityPolicyRequestSchema.openapi({
      description:
        'Body for `PUT /api/v1/admin/org-security-policies/:scopeId`. Full-resource upsert — every flag required, so replays and concurrent writes converge.',
    }),
  );

  registry.register(
    'OrgSecurityPolicyResponse',
    OrgSecurityPolicyResponseSchema.openapi({
      description: 'Policy envelope (`{ policy }`) returned by the upsert.',
    }),
  );

  registry.register(
    'DecideRoleApprovalRequest',
    DecideRoleApprovalRequestSchema.openapi({
      description:
        'Body for approve / reject. Optional decider `note` (preserved as `decisionNote` + audit). Self-approval is 403; approving without holding super_admin is 403; non-pending rows are 409.',
    }),
  );

  // Admin impersonation surface (TS-297; PRD §10.2; CLAUDE.md §3.6).
  // Diagnostic support sessions minted in the target user's name with
  // the operator preserved in the token's `actorOnBehalfOf` claim.
  // Start + end are audit-logged (`user_impersonation:start` / `:end`).
  registry.register(
    'ImpersonateUserRequest',
    ImpersonateUserRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/users/:id/impersonate`. The free-text `reason` is mandatory and lands verbatim in the audit event.',
    }),
  );

  registry.register(
    'ImpersonateUserResponse',
    ImpersonateUserResponseSchema.openapi({
      description:
        'Impersonation session: access token whose `sub` is the target user and whose `actorOnBehalfOf` claim is the operator; short-capped refresh family. Requires `user:impersonate` (super_admin only in Phase 1). Refused for self-impersonation and admin-staff targets.',
    }),
  );

  registry.register(
    'EndImpersonationRequest',
    EndImpersonationRequestSchema.openapi({
      description:
        'Body for `POST /api/v1/admin/impersonation/end` — the `sessionFamilyId` returned by the mint.',
    }),
  );

  registry.register(
    'EndImpersonationResponse',
    EndImpersonationResponseSchema.openapi({
      description:
        'End-of-impersonation receipt. `ended: false` means the family was already revoked or expired (idempotent convergence, not an error).',
    }),
  );

  // Admin subscriptions surface (TS-127 Slice 1 / TS-127-followup-9).
  // Read-only admin tooling at `GET /api/v1/admin/subscriptions` +
  // `GET /api/v1/admin/subscriptions/:id`. Gated server-side by
  // `SuperAdminRoleGuard`; the schemas themselves carry no auth metadata —
  // that's a controller-layer concern (CLAUDE.md §3.2). Sub-objects are
  // registered separately so admin-portal type-generation surfaces them
  // for re-use in future write-path follow-ups (TS-127-followup-1).
  registry.register(
    'AdminSubscriptionPlanSummary',
    AdminSubscriptionPlanSummarySchema.openapi({
      description:
        'Denormalised plan summary on every admin subscription row. Lets the list + detail pages render the plan name + price without expanding the relation graph. Prices are integer USD minor units (CLAUDE.md §17.6).',
    }),
  );

  registry.register(
    'AdminSubscriptionPaymentMethodSummary',
    AdminSubscriptionPaymentMethodSummarySchema.openapi({
      description:
        "Default payment-method summary on the admin subscription detail view. Echoes only Stripe-display fields (brand, last4, expiry) — never the PAN, CVV, or full expiry (CLAUDE.md §3.9, §17.1). Null when the subscription is `incomplete` or when the row's `default_payment_method_id` does not resolve.",
    }),
  );

  registry.register(
    'AdminSubscriptionDunningSummary',
    AdminSubscriptionDunningSummarySchema.openapi({
      description:
        'Dunning snapshot on the admin subscription detail view. Mirrors the four dunning columns plus a derived `inGracePeriod` flag computed at the call instant — clients should not cache the response.',
    }),
  );

  registry.register(
    'AdminSubscriptionPauseSummary',
    AdminSubscriptionPauseSummarySchema.openapi({
      description:
        'Pause snapshot on the admin subscription detail view. Mirrors the three pause columns plus a derived `isPaused` flag that captures both the canonical platform status and the Stripe-side `pause_collection` window.',
    }),
  );

  registry.register(
    'AdminSubscriptionSummary',
    AdminSubscriptionSummarySchema.openapi({
      description:
        'Row shape for `GET /api/v1/admin/subscriptions`. Denormalised summary (plan code + name, derived `inDunningGrace` + `isPaused` flags) so the list page renders without an N+1 fetch.',
    }),
  );

  registry.register(
    'AdminSubscriptionsListQuery',
    AdminSubscriptionsListQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/subscriptions`. Cursor-paginated; `limit` defaults to 25 and is capped at 100. Optional exact-match filters on `customerGroup`, `status`, `planId`, and `customerId`.',
    }),
  );

  registry.register(
    'AdminSubscriptionsListResponse',
    AdminSubscriptionsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/subscriptions`. `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  registry.register(
    'AdminSubscriptionHistoryEntry',
    AdminSubscriptionHistoryEntrySchema.openapi({
      description:
        'Single `subscription_history` row for the admin subscription detail view. Append-only by policy (CLAUDE.md §3.6) — every state transition produces a new row, never an update. `context` is free-form JSON capped at 8 KiB at the contract layer.',
    }),
  );

  registry.register(
    'AdminSubscriptionDetail',
    AdminSubscriptionDetailSchema.openapi({
      description:
        'Account detail shape for `GET /api/v1/admin/subscriptions/:id`. Composes the per-row columns with denormalised plan + payment-method summaries, the dunning + pause sub-objects, and the most-recent N (`ADMIN_SUBSCRIPTIONS_HISTORY_MAX` = 50) history entries newest-first. Slice 1 omits write surfaces — comp / refund / extend-trial / prorate land with TS-127-followup-1; manual dunning recovery lands with TS-127-followup-5.',
    }),
  );

  registry.register(
    'AdminSubscriptionDetailResponse',
    AdminSubscriptionDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/subscriptions/:id`. Wrapped in `{ subscription: ... }` so the shape is forward-compatible with future side-data (related invoices, related coupon redemptions) without a v1 break.',
    }),
  );

  // Admin bookings surface (TS-128 Slice 1 / TS-128-followup-10).
  // Read-only admin tooling at `GET /api/v1/admin/bookings` +
  // `GET /api/v1/admin/bookings/:id`. Gated server-side by
  // `SuperAdminRoleGuard`; the schemas themselves carry no auth metadata —
  // that's a controller-layer concern (CLAUDE.md §3.2). Sub-objects are
  // registered separately so admin-portal type-generation surfaces them
  // for re-use in future write-path follow-ups (TS-128-followup-1..3).
  // Future per-permission gating (`booking:read` for ops + concierge +
  // trust-safety) lands with TS-128-followup-11 once `PermissionGuard`
  // lifts to `packages/nest-auth` (TS-052-followup-11).
  registry.register(
    'AdminBookingVisitNoteSummary',
    AdminBookingVisitNoteSummarySchema.openapi({
      description:
        'Denormalised visit-notes snapshot on the admin booking detail view. Null when no row exists (typical for pending / confirmed bookings; permanent for never-started cancellations). Coarse-grained 5-point ordinals echo the upstream `VisitNote{Mood,Appetite,Hydration,SocialEngagement}` enums per CLAUDE.md §12 (hospitality, not clinical). All four ordinals are nullable because partial saves are accepted upstream.',
    }),
  );

  registry.register(
    'AdminBookingCheckInSummary',
    AdminBookingCheckInSummarySchema.openapi({
      description:
        'Check-in / check-out snapshot on the admin booking detail view. Geo coordinates are JSON numbers (persistence holds `Decimal(8,6)` / `Decimal(9,6)`). Phase-1 admin tooling renders raw coordinates for ops triage; the family-portal does NOT expose them (CLAUDE.md §12 family-observability boundary). Map rendering + geo-mismatch trust-safety flags live with TS-300.',
    }),
  );

  registry.register(
    'AdminBookingDisputeSummary',
    AdminBookingDisputeSummarySchema.openapi({
      description:
        'Dispute snapshot on the admin booking detail view. Welfare/safety disputes are first class (CLAUDE.md §12) — admin tooling renders the dispute-reason chip prominently for ops triage. The detail endpoint already scopes by parent-booking id so this shape carries no `bookingId` — the parent is implicit.',
    }),
  );

  registry.register(
    'AdminBookingRecurrenceSummary',
    AdminBookingRecurrenceSummarySchema.openapi({
      description:
        'Recurrence snapshot on the admin booking detail view. Null when the row is a one-off (`bookings.series_id IS NULL`). Carries the canonical RRULE + resolved termination clause + zero-based `seriesIndex` so admin tooling can show "occurrence 3 of 12" inline without a second round-trip.',
    }),
  );

  registry.register(
    'AdminBookingSummary',
    AdminBookingSummarySchema.openapi({
      description:
        'Row shape for `GET /api/v1/admin/bookings`. Denormalised summary (money in integer USD minor units per CLAUDE.md §17.6, derived `isRecurring` flag) so the list page renders without an N+1 detail fetch.',
    }),
  );

  registry.register(
    'AdminBookingsListQuery',
    AdminBookingsListQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/bookings`. Cursor-paginated; `limit` defaults to 25 and is capped at 100. Optional exact-match filters on `householdId`, `providerId`, `seniorId`, `serviceKind`, and `status`.',
    }),
  );

  registry.register(
    'AdminBookingsListResponse',
    AdminBookingsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/bookings`. `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  registry.register(
    'AdminBookingDetail',
    AdminBookingDetailSchema.openapi({
      description:
        'Detail shape for `GET /api/v1/admin/bookings/:id`. Composes the per-row columns (echoed from `BookingResponse`) with the visit-notes sub-object (one row max), the check-ins list (capped at `ADMIN_BOOKINGS_CHECK_INS_MAX` = 10), the disputes list (newest-first, capped at `ADMIN_BOOKINGS_DISPUTES_MAX` = 50), and the recurrence summary when the booking belongs to a series. Money fields are integer USD minor units per CLAUDE.md §17.6. Slice 1 omits write surfaces — manual concierge booking creation lands with TS-128-followup-1; cancel/refund with TS-128-followup-2; dispute open/resolve with TS-128-followup-3.',
    }),
  );

  registry.register(
    'AdminBookingDetailResponse',
    AdminBookingDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/bookings/:id`. Wrapped in `{ booking: ... }` so the shape is forward-compatible with future side-data (provider history with this household, related billing, related concierge tickets) without a v1 break.',
    }),
  );

  // Admin chart-of-accounts surface (TS-129-followup-1 / TS-129-followup-1a).
  // Mutation endpoint at `PATCH /api/v1/admin/accounts/:id` for flipping
  // the `active` flag (retire / activate). CLAUDE.md §6 forbids deleting
  // a chart-of-accounts row — historical journals point at it forever —
  // so retirement is the closest "delete" gesture. Gated server-side by
  // `AccessTokenGuard` → `SuperAdminRoleGuard`; future per-permission
  // gating (`accounting:adjust`) lands with TS-129-followup-2 once
  // `PermissionGuard` lifts to `packages/nest-auth`. Each transition is
  // idempotent on `Idempotency-Key`; toggling to the current state is a
  // no-op success (CLAUDE.md §3.3).
  registry.register(
    'AdminAccountActiveReason',
    AdminAccountActiveReasonSchema.openapi({
      description:
        "Categorical reason for flipping a chart-of-accounts row's `active` flag. Kept short so the dropdown UX stays crisp and the audit aggregates make sense per-category: `superseded` (a successor account took over), `chart_cleanup` (periodic catalog hygiene), `restore` (re-activating a previously-retired account), `other` (escape hatch — reach for the `note` field).",
    }),
  );

  registry.register(
    'AdminAccountActiveStateSnapshot',
    AdminAccountActiveStateSnapshotSchema.openapi({
      description:
        'Minimal before/after snapshot on the active-flag transition. Carries only the column this action touches (`active`); full row-level diff lives in the audit event when that pipe lands (TS-129-followup-3). Mirrors the AdminUserActionStateSnapshot shape.',
    }),
  );

  registry.register(
    'UpdateAccountActiveRequest',
    UpdateAccountActiveRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/accounts/:id`. `active` is the target end-state (toggling to the current state is a no-op success). `reason` is the categorical bucket for the audit pipe — required so the audit log carries the "why" for every transition. `note` is an optional free-text companion capped at `ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH` = 500.',
    }),
  );

  registry.register(
    'UpdateAccountActiveResponse',
    UpdateAccountActiveResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/accounts/:id`. Returns the updated chart-of-accounts row plus before/after snapshots, the echoed reason + note, and the actor + transition timestamp. `before == after` on no-op-success replays so the admin UI can render "no change committed" inline.',
    }),
  );

  // Admin accounting view (TS-129 Slice 1 / TS-129-followup-6). Four
  // read-only admin surfaces: journals list (`GET /api/v1/admin/journals`),
  // journal detail (`GET /api/v1/admin/journals/:id`), trial balance
  // (`GET /api/v1/admin/trial-balance`), and per-period lifecycle events
  // (`GET /api/v1/admin/periods/:periodName/events`). All gated server-
  // side by `SuperAdminRoleGuard`; the api-gateway proxy enforces the
  // same gate at the edge for defence-in-depth. Future per-permission
  // gating (`accounting:read` for ops + finance + auditor) lands with
  // TS-129-followup-2 once `PermissionGuard` lifts to
  // `packages/nest-auth` (TS-052-followup-11). Money fields are integer
  // USD minor units per CLAUDE.md §17.6 — no floats over the wire.
  // Period close / reopen + multi-currency + reconciliation diagnostic +
  // SaaS metrics + QuickBooks/CSV exports are deferred to
  // TS-129-followup-7..11 per the slice-1 boundary.
  registry.register(
    'AdminAccountingCurrency',
    AdminAccountingCurrencySchema.openapi({
      description:
        'Currency code for trial-balance + journal-line filters. Phase-1 is USD only; the enum shape leaves room for Phase-3 multi-currency expansion (TS-129-followup-7) — a future addition is a breaking-but-explicit contract change. Mirrors `AccountCurrencySchema`.',
    }),
  );

  registry.register(
    'AdminJournalLine',
    AdminJournalLineSchema.openapi({
      description:
        'Single line on the admin journal detail view. Carries `accountCode` + `accountName` denormalised onto the row so admin tooling renders without an N+1 chart-of-accounts fetch; `accountId` is also surfaced so the UI can deep-link. Money fields are integer USD minor units per CLAUDE.md §17.6.',
    }),
  );

  registry.register(
    'AdminJournalSummary',
    AdminJournalSummarySchema.openapi({
      description:
        'Row shape for `GET /api/v1/admin/journals`. Carries the envelope + pre-computed integer minor-unit totals over the embedded lines so the list page renders without an N+1 line fetch. `totalDebitMinor == totalCreditMinor` by construction (the double-entry invariant from CLAUDE.md §6); both are surfaced so the UI can render the DR / CR dual-column admin view without parsing one from the other.',
    }),
  );

  registry.register(
    'AdminJournalDetail',
    AdminJournalDetailSchema.openapi({
      description:
        'Detail view shape for `GET /api/v1/admin/journals/:id`. Composes the envelope columns with the embedded `lines` array (capped at `JOURNAL_LINES_MAX`, ordered by created_at ASC — canonical posting order) + the free-form `context` jsonb payload (cap-bounded at `ADMIN_ACCOUNTING_CONTEXT_MAX_BYTES` = 16 KiB). Append-only by policy (CLAUDE.md §6) — corrections are reversal + replacement journals, never mutations.',
    }),
  );

  registry.register(
    'AdminJournalsListQuery',
    AdminJournalsListQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/journals`. Cursor-paginated; `limit` defaults to 25 and is capped at 100. Optional period scope via `periodId` (id-precedence) or `periodName` (YYYY-MM); optional `kind` filter. The service resolves `periodName` → `periodId` internally; an unknown name returns an empty page rather than 404.',
    }),
  );

  registry.register(
    'AdminJournalsListResponse',
    AdminJournalsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/journals`. `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  registry.register(
    'AdminJournalDetailResponse',
    AdminJournalDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/journals/:id`. Wrapped in `{ journal: ... }` so the shape is forward-compatible with future side-data (linked source-event audit trail, related reversal pair, related period lifecycle event) without a v1 break.',
    }),
  );

  registry.register(
    'AdminTrialBalanceRow',
    AdminTrialBalanceRowSchema.openapi({
      description:
        'Per-account aggregate row on the trial-balance response. `debitTotalMinor` + `creditTotalMinor` are gross sums across every journal line that hit this account in scope; exactly one of `netDebitMinor` / `netCreditMinor` is non-zero (the net balance). `accountType` + `normalBalance` are denormalised so the trial-balance UI groups rows by category without an N+1 chart-of-accounts fetch.',
    }),
  );

  registry.register(
    'AdminTrialBalanceQuery',
    AdminTrialBalanceQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/trial-balance`. Optional period scope (`periodId` wins over `periodName` if both supplied); optional `currency` filter (Phase-1: USD only). When neither period filter is provided, the trial balance aggregates across ALL periods (all-time view).',
    }),
  );

  registry.register(
    'AdminTrialBalanceResponse',
    AdminTrialBalanceResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/trial-balance`. `rows` is sorted by `accountType` (asset → liability → equity → revenue → contra_revenue → expense) then by `accountCode` ascending — the canonical trial-balance display order. `totalDebitMinor == totalCreditMinor` for a balanced ledger; `imbalanceMinor` is the absolute difference (zero on a balanced ledger; reconciliation diagnostic lands with TS-129-followup-9).',
    }),
  );

  registry.register(
    'AdminPeriodEvent',
    AdminPeriodEventSchema.openapi({
      description:
        'Single lifecycle event on the per-period audit list. Mirrors `PeriodLifecycleEventResponse` 1:1 — the admin browser surfaces the same shape as the close/reopen response so the UI reuses one render path. Close + reopen lifecycle events are append-only per CLAUDE.md §6; the audit row is the durable record of every transition.',
    }),
  );

  registry.register(
    'AdminPeriodEventsListQuery',
    AdminPeriodEventsListQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/periods/:periodName/events`. Cursor-paginated only — the period scope is in the path. `limit` defaults to 25 and is capped at 100.',
    }),
  );

  registry.register(
    'AdminPeriodEventsListResponse',
    AdminPeriodEventsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/periods/:periodName/events`. `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  registry.register(
    'AdminPausedDeferredRevenueBalance',
    AdminPausedDeferredRevenueBalanceSchema.openapi({
      description:
        'One suspended deferred-revenue balance on the ops queue (TS-042-followup-3b2-followup-2a). Every field is a measurement rather than a verdict. `pausedAt` is nullable — a `paused` row without one has an unknowable age, which is the worst case on this queue, so it sorts first and is counted separately. `pastServicePeriodEnd` compares `servicePeriodEnd` (un-extended while the balance is still paused) against `asOf`: once true, the suspension has outlasted the whole period the customer paid for. `remainingDeferredMinor` is the stranded amount in integer USD minor units.',
    }),
  );

  registry.register(
    'AdminPausedDeferredRevenueSummary',
    AdminPausedDeferredRevenueSummarySchema.openapi({
      description:
        'Uncapped totals over EVERY paused deferred-revenue balance, computed independently of the capped enumeration. `accounting_recognition_pause_total` is a flow metric and cannot answer "is anything stuck right now" after a pod restart; these counts can, and they must not stop at a page boundary. `unknownPausedAtCount` bounds how far `oldestPausedAt` can be trusted.',
    }),
  );

  registry.register(
    'AdminPausedDeferredRevenueQuery',
    AdminPausedDeferredRevenueQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/deferred-revenue/paused`. No filters and no cursor — the queue is bounded by how many subscriptions are suspended at once, and a cursor would cost the uncapped totals an operator came for. `limit` caps only the enumeration (default 50, max 200). `asOf` overrides the comparison instant so ages and `pastServicePeriodEnd` are reproducible.',
    }),
  );

  registry.register(
    'AdminPausedDeferredRevenueResponse',
    AdminPausedDeferredRevenueResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/deferred-revenue/paused`. `balances` is ordered `pausedAt ASC NULLS FIRST, id ASC` — longest-suspended first, unknown-age above everything. `truncated` is stated rather than inferred from array length.',
    }),
  );

  // Booking-domain customer-facing surfaces (TS-062 visit notes, TS-063
  // check-ins, TS-061 recurrence — registration follow-up TS-063-followup-10).
  // These are the provider/family-facing schemas; the admin tooling
  // mirror lives one block above (AdminBooking*). Each block carries
  // the contract that the booking-svc HTTP surface accepts/returns and
  // that the provider portal (TS-125) + family portal (TS-124) consume
  // via type-generation against this artifact. Sub-objects are
  // registered separately so consumers get named `$ref` types rather
  // than anonymous nested shapes — important for the provider portal's
  // type-generation pipeline. Coordinates are JSON numbers on the wire
  // (persisted as `Decimal(8,6)` / `Decimal(9,6)`); money fields are
  // integer USD minor units per CLAUDE.md §17.6.

  // Visit notes (TS-062 — PRD §6.4 family peace-of-mind dashboard).
  // The four ordinal enums are coarse-grained 5-point scales by design
  // — fine-grained numeric scoring would push the platform toward
  // clinical language (CLAUDE.md §12 "hospitality, not clinical").
  // Senior-consent gating on `photoKeys` is enforced at the service
  // layer (the contract permits the array; consent check rejects it).
  registry.register(
    'VisitNoteMood',
    VisitNoteMoodSchema.openapi({
      description:
        "Coarse-grained 5-point ordinal scale for the senior's mood during the visit (low → joyful). Always optional — providers leave the field blank when they cannot read the senior's affect (e.g. a brief drop-off). Mirrors the Prisma enum `VisitNoteMood` per CLAUDE.md §12 (hospitality, not clinical — no numeric scoring).",
    }),
  );

  registry.register(
    'VisitNoteAppetite',
    VisitNoteAppetiteSchema.openapi({
      description:
        "Coarse-grained 5-point ordinal scale for the senior's appetite during the meal (none → robust). Drives PRD §6.9 wellness-summary emails and the PDD §16.1 trust-safety welfare signal when persistently `none` or `minimal`. Mirrors the Prisma enum `VisitNoteAppetite`.",
    }),
  );

  registry.register(
    'VisitNoteHydration',
    VisitNoteHydrationSchema.openapi({
      description:
        "Coarse-grained 5-point ordinal scale for the senior's hydration during the visit (poor → excellent). Persistent `poor` flags a PDD §16.1 welfare signal. Mirrors the Prisma enum `VisitNoteHydration`.",
    }),
  );

  registry.register(
    'VisitNoteSocialEngagement',
    VisitNoteSocialEngagementSchema.openapi({
      description:
        "Coarse-grained 5-point ordinal scale for the senior's social engagement during the visit (withdrawn → vibrant). Surfaced on the PRD §6.4 family peace-of-mind dashboard so adult children see engagement at a glance without reading freeform prose. Mirrors the Prisma enum `VisitNoteSocialEngagement`.",
    }),
  );

  registry.register(
    'UpsertVisitNotesRequest',
    UpsertVisitNotesRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/bookings/:id/visit-notes`. Every observation field is optional so a partial save lands a valid row; the service rejects a fully-empty payload (all-null ordinals + empty `freeform` + zero `photoKeys`) with a 400 so providers do not accidentally clear the row by submitting an empty form. `recordedByUserId` and `recordedAt` are NOT on the wire — the service stamps both from the authenticated request context per CLAUDE.md §3.2. `photoKeys` is capped at `VISIT_NOTES_PHOTO_KEYS_MAX` = 12; senior-consent gating on a non-empty array is service-enforced.',
    }),
  );

  registry.register(
    'VisitNotesResponse',
    VisitNotesResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/bookings/:id/visit-notes` and `GET /api/v1/bookings/:id/visit-notes`. Surfaces the persisted observation fields plus three audit fields (`bookingId`, `recordedByUserId`, `recordedAt`). `recordedAt` stays distinct from `updatedAt` so an internal touch (future PII-redaction moderation) does not perturb the family-facing recency. On GET, a missing row returns 404 (the family portal renders an empty-state placeholder).',
    }),
  );

  // Family peace-of-mind dashboard (TS-230 — PRD §6.4, §6.9; PDD §10).
  // `GET /api/v1/bookings/dashboard/me` resolves the household from the
  // token `tenantScope` (no id on the wire) and returns the windowed
  // upcoming list + the cursor-paginated completed-visit history with
  // visit-note summaries inlined. The summary carries `photoCount`, not
  // raw `photoKeys` — consent-gated photo rendering is owned by TS-232.
  registry.register(
    'FamilyVisitsDashboardQuery',
    FamilyVisitsDashboardQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/bookings/dashboard/me`. `windowDays` (7 | 30 | 90, default 30) bounds the upcoming list; `seniorId` is the optional per-senior tab filter (absent = combined "All seniors" view); `historyCursor` + `historyLimit` (default 10, max 50) paginate the completed-visit history. No `householdId` on the wire — the service resolves it from the token `tenantScope` (a non-household actor gets 400).',
    }),
  );

  registry.register(
    'DashboardVisitNoteSummary',
    DashboardVisitNoteSummarySchema.openapi({
      description:
        'Family-facing slice of a `booking_visit_notes` row on the dashboard history list. Carries the four coarse-grained wellness scales + the freeform narrative + `photoCount` + `recordedAt`. Deliberately omits the provider `recordedByUserId` (not a family concern) and the raw `photoKeys` (consent-gated photo rendering via media-svc signed URLs is owned by TS-232 — this surfaces only how many photos were shared).',
    }),
  );

  registry.register(
    'DashboardPastVisit',
    DashboardPastVisitSchema.openapi({
      description:
        'One completed visit in the dashboard history list — the `BookingResponse` plus its `DashboardVisitNoteSummary` (null when the provider never recorded notes).',
    }),
  );

  registry.register(
    'FamilyVisitsDashboardResponse',
    FamilyVisitsDashboardResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/bookings/dashboard/me`. `householdId` + `seniorId` echo the resolved scope (`seniorId` null for the combined view). `upcoming` is the window-bounded, soonest-first list of not-yet-ended bookings (`pending` | `confirmed` | `in_progress`), hard-capped at `DASHBOARD_UPCOMING_MAX` and NOT cursor-paginated. `history` is the newest-first list of completed visits with inlined visit-note summaries; `historyNextCursor` is null on the last page. Completed-only by design — cancelled / declined awareness is owned by TS-234.',
    }),
  );

  // Wellness trends (TS-231 — PRD §6.4, §6.9; PDD §23.1). Per-senior,
  // per-visit observation series over a 30 / 90-day window. The service
  // surface (service-booking) returns `WellnessTrendsResponse`; the
  // gateway BFF wraps it as `FamilyWellnessTrendsResponse` with the
  // consent `shared` flag (TS-238 `notes` surface).
  registry.register(
    'WellnessTrendsQuery',
    WellnessTrendsQuerySchema.openapi({
      description:
        'Query for the wellness-trend reads (`GET /api/v1/bookings/seniors/:seniorId/wellness-trends` and the gateway `GET /api/v1/seniors/:seniorId/wellness-trends`). `windowDays` (30 | 90, default 30) bounds the look-back; the senior id rides in the path.',
    }),
  );

  registry.register(
    'WellnessTrendPoint',
    WellnessTrendPointSchema.openapi({
      description:
        "One completed visit's observation of a single wellness scale: `visitDate` (the booking's scheduledStart — the x-axis), `recordedAt` (when the provider wrote the note), `level` (the ordinal string), and `score` (its 1..5 position in the scale).",
    }),
  );

  registry.register(
    'WellnessTrendSeries',
    WellnessTrendSeriesSchema.openapi({
      description:
        "One wellness scale's trend line: its `points` in chronological order, `latestScore` (the most-recent reading, null when no visit recorded the scale), and `visitsRecorded` (the line's sample size). Each metric's series includes only the visits where that scale was recorded.",
    }),
  );

  registry.register(
    'WellnessTrendsResponse',
    WellnessTrendsResponseSchema.openapi({
      description:
        'service-booking response for `GET /api/v1/bookings/seniors/:seniorId/wellness-trends`. `series` carries all four scales (mood / appetite / hydration / social_engagement) in fixed order; `totalCompletedVisits` is the true completed-visit count in the window (the denominator). No `householdId` on the wire — resolved from the token `tenantScope`.',
    }),
  );

  registry.register(
    'FamilyWellnessTrendsResponse',
    FamilyWellnessTrendsResponseSchema.openapi({
      description:
        "Gateway BFF response for `GET /api/v1/seniors/:seniorId/wellness-trends`. Adds the consent `shared` flag (TS-238 `notes` surface) like the TS-232 photo gallery: `shared: false` (a family observer the senior hasn't shared `notes` with) carries empty series + `totalCompletedVisits: 0` — the trends never cross. The primary payer + the senior always see (`shared: true`).",
    }),
  );

  // Wellness anomalies (TS-236 — PRD §6.9; PDD §23.1). The early-warning
  // layer on the TS-231 trend data: an EWMA-baseline-vs-recent-mean
  // decline detector flags scales that have slipped relative to the
  // senior's own recent baseline. Service surface returns
  // `WellnessAnomalyResponse`; the gateway BFF wraps it as
  // `FamilyWellnessAnomalyResponse` with the consent `shared` flag.
  registry.register(
    'WellnessAnomalySeverity',
    WellnessAnomalySeveritySchema.openapi({
      description:
        'Anomaly severity tier: `moderate` (drop ≥ WELLNESS_ANOMALY_DROP_MODERATE below baseline) or `high` (drop ≥ WELLNESS_ANOMALY_DROP_HIGH — a pronounced slide). `high` outranks `moderate`.',
    }),
  );

  registry.register(
    'WellnessAnomalyFlag',
    WellnessAnomalyFlagSchema.openapi({
      description:
        'One flagged wellness scale: `metric`, `severity`, the numeric evidence (`baselineScore` EWMA over the pre-recent visits, `recentScore` mean of the last WELLNESS_ANOMALY_RECENT_WINDOW visits, `drop` = baseline − recent), the most recent reading (`latestLevel` ordinal word + `latestVisitDate`), and `observationCount` (the sample size). Decline detection only — a persistently-low level is not flagged here.',
    }),
  );

  registry.register(
    'WellnessAnomalyResponse',
    WellnessAnomalyResponseSchema.openapi({
      description:
        'service-booking response for `GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies`. `flags` carries only the scales that tripped a decline (empty when all is well). `totalCompletedVisits` is the window denominator. No `householdId` on the wire — resolved from the token `tenantScope`.',
    }),
  );

  registry.register(
    'FamilyWellnessAnomalyResponse',
    FamilyWellnessAnomalyResponseSchema.openapi({
      description:
        "Gateway BFF response for `GET /api/v1/seniors/:seniorId/wellness-anomalies`. Adds the consent `shared` flag (TS-238 `notes` surface) like the wellness trends + photo gallery: `shared: false` (a family observer the senior hasn't shared `notes` with) carries empty `flags` + `totalCompletedVisits: 0` — nothing crosses. The primary payer + the senior always see (`shared: true`).",
    }),
  );

  // Check-ins (TS-063 — PRD §7.4 provider visit workflow).
  // The check-in / check-out pair is the trust signal that drives PRD
  // §6.4 "provider has arrived" + the TS-083 commission-recognition
  // pipeline on `booking.completed` + the TS-091 payouts accrual. Geo
  // coordinates are JSON numbers on the wire (persisted as Decimal);
  // the family portal does NOT render them by default (CLAUDE.md §12
  // family-observability boundary — provider precise location is not a
  // family concern). Each (bookingId, kind) pair is UNIQUE — one
  // check-in row + one check-out row per booking max.
  registry.register(
    'BookingCheckInKind',
    BookingCheckInKindSchema.openapi({
      description:
        'Check-in kind discriminator: `check_in` (provider arrived; flips booking `confirmed` → `in_progress` + emits `booking.in_progress`) or `check_out` (provider departed; flips `in_progress` → `completed` + emits `booking.completed`). Mirrors the Prisma enum `BookingCheckInKind`.',
    }),
  );

  registry.register(
    'RecordBookingCheckInRequest',
    RecordBookingCheckInRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/bookings/:bookingId/check-ins`. Geo coordinates are required — Phase 1 product position is that providers must enable device location to check in/out; the admin override surface (TS-128) handles the "location unavailable" edge cases. `recordedByUserId` and `occurredAt` are NOT on the wire — the service stamps both from the authenticated request context + a trusted clock per CLAUDE.md §3.2. Latitude bounded `[-90, 90]`, longitude `[-180, 180]`; `locationAccuracyMeters` is optional (some devices do not surface accuracy).',
    }),
  );

  registry.register(
    'BookingCheckInResponse',
    BookingCheckInResponseSchema.openapi({
      description:
        'Single `booking_check_ins` row shape. Coordinates are JSON numbers (persisted as `Decimal(8,6)` / `Decimal(9,6)` ≈ 11 cm precision); `locationAccuracyMeters` is the optional browser geolocation horizontal accuracy estimate (nullable in storage). Returned standalone by the list endpoint and embedded in the create-response envelope.',
    }),
  );

  registry.register(
    'RecordBookingCheckInResponse',
    RecordBookingCheckInResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/bookings/:bookingId/check-ins`. Returns both the new check-in row AND the updated booking (the transition is server-driven — the same request that records the row flips the booking status), so the provider / family portal renders the new state without a follow-up GET round-trip. A retried POST with the same `Idempotency-Key` replays this exact response; an unkeyed retry surfaces a typed `already_recorded` failure on the `(bookingId, kind)` UNIQUE violation.',
    }),
  );

  registry.register(
    'BookingCheckInsListResponse',
    BookingCheckInsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/bookings/:bookingId/check-ins`. Returns every check-in row for the booking, ordered chronologically (oldest first — natural for "the visit started at … and ended at …" timeline rendering). At most two rows in Phase 1 (one `check_in` + one `check_out`); a future "provider stepped out and re-entered" surface would add rows additively without a contract break.',
    }),
  );

  // Recurrence (TS-061 — PRD §6.3 weekly / biweekly / monthly series).
  // One write surface (`POST /api/v1/bookings/recurring`) accepts the
  // per-booking shape plus an RFC 5545 RRULE + termination clause. The
  // Phase-1 expander supports `FREQ=WEEKLY;INTERVAL=1|2` and
  // `FREQ=MONTHLY;INTERVAL=1` with `COUNT=N` or `UNTIL=...`; the hard
  // cap `RECURRENCE_MAX_OCCURRENCES` = 52 bounds the materialised
  // series at one year of weekly visits. Atomic explode: every child
  // row + the recurrence row + outbox events land in one Prisma
  // `$transaction` so partial series never reach Postgres. Full RFC
  // 5545 coverage + per-occurrence overrides land with TS-061-followup-1
  // / TS-061-followup-3.
  registry.register(
    'BookingRecurrencePattern',
    BookingRecurrencePatternSchema.openapi({
      description:
        'Recurrence pattern carried on the create-recurring-booking request. Subschema rather than a flat field so future additions (timezone overrides, BYDAY clauses, exception dates) land additively. `rrule` is an RFC 5545 string capped at `RRULE_MAX_LENGTH` = 500; unsupported clauses (`BYDAY`, `BYMONTHDAY`, `WKST`, `BYSETPOS`, etc.) surface as a typed `unsupported_rrule_clause` failure at the service boundary so the Phase-1 subset can grow additively (TS-061-followup-1).',
    }),
  );

  registry.register(
    'CreateRecurringBookingRequest',
    CreateRecurringBookingRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/bookings/recurring`. Composes the per-occurrence fields of `CreateBookingRequest` (household / senior / provider ids, serviceKind, scheduled window, currency, money fields, optional bookingNotes) plus the `recurrence` block. `scheduledStart` / `scheduledEnd` define the FIRST occurrence; the server-side expander walks forward from that anchor. Money fields are integer USD minor units per CLAUDE.md §17.6. `bookingNotes` propagates to every materialised occurrence; per-occurrence overrides land with TS-061-followup-3.',
    }),
  );

  registry.register(
    'BookingRecurrenceRecord',
    BookingRecurrenceRecordSchema.openapi({
      description:
        'Persisted recurrence record returned on the create response so the caller learns the canonical RRULE + resolved termination clause back. Exactly one of `endDate` / `count` is non-null — the server resolves whichever the RRULE carried. `occurrenceCount` is the count actually materialised (clamped to `RECURRENCE_MAX_OCCURRENCES` = 52). `seriesId` matches the `seriesId` stamped on every child booking row so the family-portal + ops queries can group occurrences without a back-join to `booking_recurrence`.',
    }),
  );

  registry.register(
    'CreateRecurringBookingResponse',
    CreateRecurringBookingResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/bookings/recurring`. Returns the recurrence record plus every materialised child booking (full `BookingResponse` shape) so the family portal renders the entire series without a second round-trip. The `bookings` array is bounded `[1, RECURRENCE_MAX_OCCURRENCES = 52]`. The atomic explode means a partial-success response is impossible: either the whole series lands and this response returns, or the transaction aborts and no rows are persisted.',
    }),
  );

  // Booking tier snapshots (TS-064 — PRD §5.1 / §5.2; CLAUDE.md §12 tier
  // gating; registration follow-up TS-064-followup-6). service-booking
  // enforces "Tier 3 Concierge households can only book Elite Concierge
  // providers" at the SERVICE LAYER. Household + provider tier ownership
  // live in `service-subscription` + `service-provider` respectively;
  // CLAUDE.md §2.3 forbids cross-service joins, so service-booking
  // maintains its own read-side cache of tier snapshots hydrated either
  // by the `subscription.tier_changed` / `provider.tier_changed` events
  // (TS-142 outbox + relay) or by the Phase-1 internal HTTP endpoints
  // whose contracts these schemas back. Both endpoints are shared-secret
  // pinned (mirrors the established service-identity KYC internal-
  // dispatch pattern from TS-026); the schemas themselves carry no auth
  // metadata — that's a controller-layer concern (CLAUDE.md §3.2).
  registry.register(
    'HouseholdSubscriptionTier',
    HouseholdSubscriptionTierSchema.openapi({
      description:
        'Household subscription tier — mirrors the Prisma `household_subscription_tier` enum (TS-064). Three-variant taxonomy matching PRD §5.1 family-membership tiers (Essential / Companion Dining / Concierge Lifestyle). `tier_3_concierge` is the GATED variant — Tier-3 households can only book Elite Concierge providers per CLAUDE.md §12; other tiers can book any provider tier (no upward gate).',
    }),
  );

  registry.register(
    'ProviderTierSnapshotTier',
    ProviderTierSnapshotTierSchema.openapi({
      description:
        "Provider tier snapshot — mirrors `service-provider`'s `ProviderTier` enum. Three variants matching PRD §5.2 provider tiers (Basic / Certified Culinary Companion / Elite Concierge Provider). `elite` is the only tier eligible to fulfil a Tier-3 Concierge household's booking per CLAUDE.md §12.",
    }),
  );

  registry.register(
    'UpsertHouseholdTierSnapshotRequest',
    UpsertHouseholdTierSnapshotRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/booking/tier-snapshots/household`. The caller (ops via the gateway BFF, or eventually the `subscription.tier_changed` consumer) supplies the household id + the categorical tier + the producer-side ISO 8601 timestamp. `sourceEventId` is optional — set when called by an event consumer so the row records the lineage; null when called by ops / gateway BFF. Internal-only endpoint pinned by shared secret (mirrors the TS-026 KYC internal-dispatch pattern).',
    }),
  );

  registry.register(
    'UpsertProviderTierSnapshotRequest',
    UpsertProviderTierSnapshotRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/booking/tier-snapshots/provider`. Mirror of `UpsertHouseholdTierSnapshotRequest` for the provider side — the caller supplies the provider id + categorical tier + producer-side timestamp + optional source event id. Internal-only endpoint pinned by shared secret.',
    }),
  );

  registry.register(
    'HouseholdTierSnapshotResponse',
    HouseholdTierSnapshotResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/booking/tier-snapshots/household` — the upserted row shape. `sourceEventId` is `string | null` on the wire because the column is nullable in the database (the ops/gateway HTTP path leaves it null; the event-consumer path sets it). `createdAt` and `updatedAt` are server-stamped — the wire shape reflects the persisted row.',
    }),
  );

  registry.register(
    'ProviderTierSnapshotResponse',
    ProviderTierSnapshotResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/booking/tier-snapshots/provider` — the upserted row shape. Mirror of `HouseholdTierSnapshotResponse` for the provider side. `sourceEventId` is nullable on the wire (null on the ops/gateway path, set on the event-consumer path); `createdAt` and `updatedAt` are server-stamped.',
    }),
  );

  // Booking disputes (TS-065 — PRD §10.5 dispute resolution workflow;
  // registration follow-up TS-065-followup-9). Four endpoints span the
  // dispute lifecycle: `POST /api/v1/bookings/:bookingId/disputes` opens
  // a dispute (idempotent on `Idempotency-Key`); `GET
  // /api/v1/bookings/:bookingId/disputes` lists every dispute for the
  // booking ordered by createdAt ASC; `GET /api/v1/disputes/:disputeId`
  // reads a single row; `PATCH /api/v1/disputes/:disputeId` transitions
  // the dispute through the state machine (open → under_review →
  // resolved/dismissed, or direct close to terminal; idempotent on
  // `Idempotency-Key`). All gated server-side by `AccessTokenGuard`;
  // future per-permission gating (`booking:adjust` for concierge / ops)
  // lands with TS-065-followup-5 / TS-128. The opener (`openedByUserId`
  // + `openedByRole`) is stamped server-side from the authenticated
  // request context per CLAUDE.md §3.2; clients never supply actor ids.
  // PII discipline (CLAUDE.md §3.9): `reasonDetail` + `resolutionNotes`
  // free-text columns cross the wire on direct reads/writes but are NOT
  // carried on the corresponding domain events (`booking.dispute_opened`
  // / `booking.dispute_resolved`) — the events carry boolean
  // `hasReasonDetail` / `hasResolutionNotes` flags so consumers know
  // presence without seeing the text. `welfare_concern` is first-class
  // (CLAUDE.md §12); the `service-trust-safety` consumer routes this
  // reason into the mandated-reporter workflow when TS-300 + TS-142
  // land.
  registry.register(
    'BookingDisputeReason',
    BookingDisputeReasonSchema.openapi({
      description:
        'Categorical reason for the dispute — mirrors the Prisma `booking_dispute_reason` enum (TS-065). Nine-variant taxonomy: `no_show`, `late_arrival`, `early_departure`, `service_quality`, `billing_dispute`, `property_damage`, `safety_concern`, `welfare_concern`, `other`. The enum keeps the consumer-side aggregation pipeline (TS-065-followup-2 trust-safety + TS-065-followup-4 refund routing) categorical without joining back to the row. `welfare_concern` is first-class (CLAUDE.md §12) and routes into the mandated-reporter workflow.',
    }),
  );

  registry.register(
    'BookingDisputeOpenedByRole',
    BookingDisputeOpenedByRoleSchema.openapi({
      description:
        'Dispute opener role — mirrors the Prisma `booking_dispute_opener_role` enum. Server-stamped from the authenticated request context per CLAUDE.md §3.2; never client-supplied. Three variants: `family`, `provider`, `admin`.',
    }),
  );

  registry.register(
    'BookingDisputeStatus',
    BookingDisputeStatusSchema.openapi({
      description:
        "Dispute lifecycle status — mirrors the Prisma `booking_dispute_status` enum (TS-065). Four-state machine: `open` → `under_review` → `resolved`/`dismissed` (terminal), or `open` → `resolved`/`dismissed` direct close. Terminal states are reached at most once per row; re-opening is intentionally not modelled — a new complaint opens a new dispute row to preserve the prior resolution's audit trail.",
    }),
  );

  registry.register(
    'TransitionableBookingDisputeStatus',
    TransitionableBookingDisputeStatusSchema.openapi({
      description:
        'Subset of `BookingDisputeStatus` accepted by the PATCH endpoint — the API never lets a caller flip a dispute back to `open`. The service-layer state machine enforces legal transitions; this schema bounds the request payload up-front so an illegal target surfaces as a 400 before the service is even invoked.',
    }),
  );

  registry.register(
    'OpenBookingDisputeRequest',
    OpenBookingDisputeRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/bookings/:bookingId/disputes`. The opener (family / provider / admin) selects a categorical `reason` and optionally attaches a freeform narrative in `reasonDetail` (capped at `BOOKING_DISPUTE_REASON_DETAIL_MAX_LENGTH` = 2000 chars). The service stamps `openedByUserId` + `openedByRole` server-side from the authenticated request context per CLAUDE.md §3.2; clients never supply actor ids. Idempotent on `Idempotency-Key` — a retried POST replays the original response; an unkeyed retry lands a SECOND dispute row (multiple disputes per booking are permitted: a billing dispute by family + a property-damage dispute by provider against the same booking are independent rows).',
    }),
  );

  registry.register(
    'UpdateBookingDisputeRequest',
    UpdateBookingDisputeRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/disputes/:disputeId`. Transitions the dispute to `targetStatus`; the service validates the transition against the state machine and rejects with 409 on illegal transitions (e.g. `resolved → under_review`). `resolutionNotes` is REQUIRED when `targetStatus` is `resolved` or `dismissed` (the terminal states need a documented outcome — preserved as the audit trail on the row + as the boolean `hasResolutionNotes` flag on the resolved event). The schema enforces this via `.superRefine`. `resolvedByUserId` / `resolvedAt` are NOT on the wire — the service stamps both server-side from the authenticated request context + a trusted clock. Idempotent on `Idempotency-Key`.',
    }),
  );

  registry.register(
    'BookingDisputeResponse',
    BookingDisputeResponseSchema.openapi({
      description:
        'Single `booking_disputes` row shape, surfaced to the client. `resolvedByUserId` / `resolvedAt` / `resolutionNotes` are null on `open` / `under_review` rows and non-null on terminal rows — a database CHECK constraint enforces the invariant that all three resolution columns transition together. Free-text `reasonDetail` + `resolutionNotes` cross the wire on direct reads but are deliberately omitted from the corresponding domain events (`booking.dispute_opened` / `booking.dispute_resolved`) per CLAUDE.md §3.9 PII discipline — events carry boolean presence flags instead.',
    }),
  );

  registry.register(
    'BookingDisputesListResponse',
    BookingDisputesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/bookings/:bookingId/disputes`. Lists every dispute for the booking, ordered by `createdAt` ascending (oldest first — natural for "this is what happened with this booking over time" timeline rendering). Empty list (booking exists but no disputes) is a 200 with `items: []`; a missing booking is a 404.',
    }),
  );

  // Gateway actor surface (TS-140 / TS-140-followup-6). `GET /api/v1/me` on
  // the api-gateway returns a `MeResponse` derived entirely from the
  // verified access token's `RequestContext` — no downstream service hops.
  // Registering the response shape + its two sub-objects (the
  // discriminated-union tenant scope + the per-role assignment) gives the
  // family-portal + provider-portal + admin-portal type-generation
  // pipelines a named `$ref` for the actor shape so they consume one
  // canonical type rather than hand-mirroring the structure on each side.
  registry.register(
    'MeTenantScope',
    MeTenantScopeSchema.openapi({
      description:
        "Discriminated-union tenant scope carried on the actor surface. `type: 'global'` is the default for platform-wide accounts; `type: 'tenant'` binds the actor to a specific partner organisation (TS-400 partner portal); `type: 'household'` binds the actor to a specific household (the common family-payer / family-observer shape). Mirrors `service-identity`'s `user_role_scope_type` Postgres enum on the wire.",
    }),
  );

  registry.register(
    'MeRoleAssignment',
    MeRoleAssignmentSchema.openapi({
      description:
        'Single role assignment on the actor surface. `name` is the role identifier (e.g. `family_payer`, `provider`, `super_admin`); `permissions` is the resolved permission set the role grants (`resource:action` strings per CLAUDE.md §2.2); `scope` is the discriminated-union tenant scope this assignment is bound to (matches `MeTenantScope`); `expiresAt` is set when the grant carries an expiration (TS-024-followup-4 reviewer-required grants), null otherwise. The portal renders `permissions` directly into capability checks — no second round-trip needed to learn what the actor can do.',
    }),
  );

  registry.register(
    'MeResponse',
    MeResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/me` on the api-gateway (TS-140). Derived from the verified access token's `RequestContext` plus one cached household-membership read (TS-505d2-followup-5a). Load-bearing for the family-portal nav-bar that fetches it on every route change. `sessionId` is null when the token was minted without a session anchor (e.g. magic-link / service-to-service tokens — Phase-2 surfaces). **`tenantScope` and `households` answer different questions**: which household THIS request is acting in, versus which ones the actor COULD act in — with several memberships the scope stays `global` until the client names one via the `X-Household-Id` header, and `households` is what the portal renders that choice from. `households` is always present and `[]` for staff, providers and partner users. The remaining downstream-derived enrichments (name, email, phone — owned by service-identity) land via dedicated endpoints the portal calls when it needs the richer view.",
    }),
  );

  // Notification dispatch + user preferences surfaces (TS-073 — PRD §10.15
  // notifications & communications; PDD §12.1 channel inventory + §12.3
  // preferences + quiet hours + senior-mode defaults; registration follow-
  // up TS-073-followup-13). Three endpoint clusters back these schemas:
  // (1) user self-service preferences at `GET /api/v1/notification/
  // preferences/me` + `PUT /api/v1/notification/preferences/me` behind
  // `AccessTokenGuard`; (2) internal dispatch at `POST /api/v1/internal/
  // notification/dispatch` pinned by shared secret (mirrors the TS-026
  // KYC + TS-064 tier-snapshot internal-dispatch pattern); (3) admin
  // dispatch history at `GET /api/v1/admin/notification/dispatches`
  // behind `AccessTokenGuard` (future per-permission gating
  // `notification:read` lands with TS-073-followup-11 once `PermissionGuard`
  // lifts to `packages/nest-auth` via TS-052-followup-11). The orchestrator
  // composes globally-unsubscribed → preference opt-out → quiet-hours
  // suppression with transactional-only bypass (CLAUDE.md §3.2 server-
  // stamping of `recipientUserId` ↔ preference lookup; TCPA / CAN-SPAM
  // compliance forces marketing categories to be explicit opt-in while
  // transactional categories default to opt-in unless explicitly opted
  // out). Idempotent on `idempotencyKey` — a replayed POST returns the
  // original row with `replayed: true`. The notification.schema.ts side
  // (templates + render + locale + channel-kind shapes) is the
  // companion surface owned by TS-072-followup-12; both follow-ups
  // share the file pair but land separately so each PR stays mechanically
  // reviewable. The composed `NotificationChannelKind` + `NotificationLocale`
  // enums imported from notification.schema.ts are inlined at every
  // composition site here pending TS-072-followup-12's registration.
  registry.register(
    'NotificationCategory',
    NotificationCategorySchema.openapi({
      description:
        'Notification category — drives the preference gate + the quiet-hours bypass logic. `transactional` is directly tied to a user action (OTP, password reset, booking confirmation, payment receipt, dispute resolution) and defaults to opt-in; the high-urgency subset bypasses quiet hours via the caller-supplied `bypassQuietHours: true` flag. `marketing` is opt-in only (TCPA / CAN-SPAM) and always honours quiet hours. `system` carries operational notices (privacy-policy updates, mandatory-reporter follow-ups, account-locked alerts) — defaults to opt-in (a user cannot meaningfully opt out of a privacy update) but honours quiet hours unless flagged urgent.',
    }),
  );

  registry.register(
    'NotificationDispatchStatus',
    NotificationDispatchStatusSchema.openapi({
      description:
        'Dispatch lifecycle status recorded on the `notification_dispatches` row. `queued` (orchestrator accepted; adapter call pending — Phase 1 is synchronous, the transient state exists for the Phase-2 BullMQ refactor per TS-073-followup-8), `sent` (adapter returned ok + provider message id), `failed` (adapter returned an error; the row carries the provider error code), `suppressed_by_preference` (user opted out of the channel/category pair), `suppressed_by_quiet_hours` (call landed inside the quiet-hours window and did not request bypass), `suppressed_by_unsubscribed` (user has globally unsubscribed — CAN-SPAM compliance gate). Mirrors the Prisma `notification_dispatch_status` enum.',
    }),
  );

  registry.register(
    'NotificationSuppressionReason',
    NotificationSuppressionReasonSchema.openapi({
      description:
        'Why was a dispatch suppressed? Set on the row when status is one of the `suppressed_by_*` variants; null otherwise. Mirrors the Prisma `notification_suppression_reason` enum. The narrower taxonomy (`preference_opted_out`, `quiet_hours`, `globally_unsubscribed`, `recipient_address_missing`) lets admin tooling aggregate suppressions by root cause without parsing the broader status enum.',
    }),
  );

  registry.register(
    'QuietHoursWindow',
    QuietHoursWindowSchema.openapi({
      description:
        'Quiet-hours window on a user preference row. Stored as minute-of-day `[0, 1440)` integers paired with the user\'s IANA time-zone so the gate can reconstruct "is `now` between 20:00 and 08:00 in the user\'s local time?" without DST ambiguity. The triple is either fully set (a window is configured) or fully null (the user has no window — the gate falls back to the senior-mode default if the user is senior-flagged). Wrap-around windows (start > end, e.g. 21:00–08:00 across midnight) are explicitly supported and are the dominant case for senior-mode users per PDD §12.3 ("no marketing pushes after 8pm"). Zero-width windows (start == end) are rejected at the contract layer.',
    }),
  );

  registry.register(
    'PreferenceEntry',
    PreferenceEntrySchema.openapi({
      description:
        'Single `(channel, category, optIn)` row on the preferences upsert request. The composite key matches the Prisma `(user_id, channel, category)` UNIQUE — one row per channel/category pair per user. Upserts are full-replace per request (`UpsertPreferencesRequest.entries` is the authoritative list; any row not named in the request is deleted), so the wire-shape is unambiguous.',
    }),
  );

  registry.register(
    'UpsertPreferencesRequest',
    UpsertPreferencesRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/notification/preferences/me`. `entries` is the authoritative list of per-`(channel, category)` opt-in rows (capped at 64); rows not named are deleted (full-replace semantics). The optional `quietHours` window applies to the entire user (not per-channel — quiet hours are an intrinsic property of "when does this person want a phone notification"); pass `null` to clear an existing window. The service stamps the `userId` from the authenticated request context per CLAUDE.md §3.2; clients never supply actor ids.',
    }),
  );

  registry.register(
    'ResolvedPreferenceEntry',
    ResolvedPreferenceEntrySchema.openapi({
      description:
        'Single resolved preference row on the `UserPreferencesResponse`. Mirrors `PreferenceEntry` plus a derived `explicit: boolean` — true when a DB row exists, false when the value is a synthesised default. The defaults follow PDD §12.3 (transactional always opt-in; marketing opt-out unless the user has explicitly opted in; senior-mode adds the 20:00–08:00 quiet-hours window for marketing kinds). Surfacing `explicit` lets the UI render "default" vs "your choice" indicators without re-deriving the defaults client-side.',
    }),
  );

  registry.register(
    'UserPreferencesResponse',
    UserPreferencesResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/notification/preferences/me` and the successful body of `PUT /api/v1/notification/preferences/me`. Echoes the resolved preferences including the synthesised defaults that the service computes for any unrecorded `(channel, category)` pair — the UI never has to re-derive defaults. `seniorMode: true` flips the default-set per PDD §12.3 (senior-mode default: no marketing pushes after 8pm); the flag is set by admin tooling or by the `senior.intake_completed` event consumer (TS-073-followup-14) and is NOT user-toggleable from this endpoint. `updatedAt` is null when no row has ever been written (the response is entirely defaults).',
    }),
  );

  registry.register(
    'DispatchNotificationRequest',
    DispatchNotificationRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/internal/notification/dispatch`. Upstream services that want to send a notification POST this shape with the shared-secret header. The orchestrator resolves `(templateCode, locale)` against the existing template registry, runs the preference + quiet-hours gate, and routes to the channel adapter (Postmark / Twilio / Firebase / in-app via TS-073-followup-1..4). `recipientUserId` is the soft-FK into `identity.users.id` and drives the preference lookup; `recipientAddress` is the channel-specific address (a senior's email lives on the family payer's row, so the caller passes it explicitly rather than reaching into a sibling service per CLAUDE.md §2.3). `variables` is the Handlebars substitution payload. `bypassQuietHours: true` lands at 02:00 only when `category = 'transactional'` (the orchestrator refuses the bypass for marketing + system). Idempotent on `idempotencyKey` (16–200 chars) — replays return the original row with `replayed: true`. `sourceEventId` is the optional caller-supplied trace id for cross-service correlation.",
    }),
  );

  registry.register(
    'DispatchResponse',
    DispatchResponseSchema.openapi({
      description:
        'Returned dispatch row, surfaced to both the internal POST caller and the admin dispatch-history list. `status` is the discriminator — the `suppressed_by_*` variants carry a non-null `suppressionReason`; the `failed` variant carries `errorMessage`; the `sent` variant carries `providerMessageId` (Postmark MessageID / Twilio SID / FCM messageId / null for in-app). Database CHECK constraints enforce these per-status invariants at the storage layer. `templateVersionId` is null for stub-mode (development) sends; live sends carry the resolved version id. `replayed: true` indicates the row is the original write returned via the idempotency-key short-circuit (no second adapter call was made). `sentAt` is the wall-clock instant the adapter confirmed delivery; null on every status other than `sent`. The recipient address crosses the wire on the admin history list — gated by `notification:read` once TS-073-followup-11 lifts the permission guard.',
    }),
  );

  registry.register(
    'ListDispatchesQuery',
    ListDispatchesQuerySchema.openapi({
      description:
        "Query parameters for `GET /api/v1/admin/notification/dispatches`. Cursor-paginated (`limit` defaults to 50, capped at 200); optional exact-match filters on `recipientUserId`, `channel`, `category`, `status`. `cursor` is opaque to clients (a base64 envelope of the last row's `(occurredAt, id)`); pass back the value returned in `nextCursor` to advance. PII discipline (CLAUDE.md §3.9): the recipient address is NOT a filterable column — filtering would require an index that doubles as a bulk-exfil bucket; user-id filtering is the equivalent narrowing surface.",
    }),
  );

  registry.register(
    'DispatchesListResponse',
    DispatchesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/notification/dispatches`. `dispatches` is ordered by `occurredAt` descending (newest-first — natural for an ops "what happened to this user recently" investigation). `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  // Notification templates + render surface (TS-072 — PDD §12.2 templating
  // with MJML + Handlebars; PDD §10.15 admin notification template
  // management with versioning + preview + test sends; registration
  // follow-up TS-072-followup-12). Companion to the notification-dispatch
  // block above — both follow-ups share the file pair but land separately
  // so each PR stays mechanically reviewable. The two halves are:
  //   (1) admin template CRUD — `POST/GET /api/v1/admin/notification/
  //   templates`, `POST /:id/versions`, `POST /:id/versions/:n/activate`
  //   behind `AccessTokenGuard` (future per-permission gating
  //   `notification:write` lands with TS-072-followup-7 once
  //   `PermissionGuard` lifts to `packages/nest-auth` via
  //   TS-052-followup-11);
  //   (2) internal render — `POST /api/v1/internal/notification/render`
  //   pinned by shared secret (mirrors the TS-026 KYC + TS-064 tier-
  //   snapshot internal-dispatch pattern; the channel dispatchers from
  //   TS-073 call this endpoint at send time).
  // Templates are keyed by `(code, locale)` UNIQUE; versions are monotonic
  // per template and immutable once written (TS-072-followup-11 adds the
  // DB trigger that enforces append-only at the storage layer). Variables
  // are typed via a small declarative schema (`NotificationVariableEntry`)
  // — Phase 1 supports only `string` / `number` / `boolean` primitives per
  // PDD §12.2 "variables strictly typed via shared contract package"; the
  // renderer rejects requests missing a required variable and short-
  // circuits on unknown variables. Three enums (`NotificationChannelKind`,
  // `NotificationVariableType`, `NotificationLocale`) are inlined at
  // every composition site in notification-dispatch.schema.ts above
  // pending this registration — registering them here as top-level
  // `$ref`-able components resolves the cosmetic-inline duplication that
  // TS-073-followup-13's completed entry called out.
  registry.register(
    'NotificationChannelKind',
    NotificationChannelKindSchema.openapi({
      description:
        'Notification channel kind. Mirrors PDD §12.1 channel inventory: `email` (transactional email via Postmark / SES), `sms` (Twilio booking reminders, OTPs, escalations), `push` (APNs + FCM via Firebase), `in_app` (real-time WebSocket fan-out wired in TS-070 messaging deck + TS-073-followup-4 in-app dispatcher). `email` is the only kind that consumes MJML/HTML bodies; the others consume `bodyText` only — `CreateTemplateVersionRequest` enforces this with a kind-specific `superRefine` joining the kind off the template row at the controller layer.',
    }),
  );

  registry.register(
    'NotificationVariableType',
    NotificationVariableTypeSchema.openapi({
      description:
        'Notification template variable type — restricted to the three JSON-safe primitives (`string`, `number`, `boolean`) the Handlebars renderer can substitute without further escaping. Object / array variables would require a nested-shape templating contract not in Phase 1 scope; TS-073 evaluates whether they are needed in practice.',
    }),
  );

  registry.register(
    'NotificationLocale',
    NotificationLocaleSchema.openapi({
      description:
        'Notification locale tag. PRD §11.4 names en-US as the Phase-1 launch locale plus es-US + zh-CN for Phase 2 — the schema lists all three up front so the admin tooling can author Phase-2 templates ahead of channel launch. BCP-47 tags wider than this set would land via a v1.x additive extension.',
    }),
  );

  registry.register(
    'NotificationVariableEntry',
    NotificationVariableEntrySchema.openapi({
      description:
        "One entry in a template version's `variablesSchema` declarative blob. Declares the variable's `name` (Handlebars-safe identifier — alphanumeric + underscore via `NOTIFICATION_VARIABLE_NAME_REGEX`), `type` (one of the three JSON-safe primitives), `required` flag (the renderer rejects a render request that omits a required variable with 422), and an optional `description` rendered in the admin UI to help the operator pick the right value at template-author time. Variable arrays cap at 40 entries per template version and reject duplicate names at the contract layer.",
    }),
  );

  registry.register(
    'CreateTemplateRequest',
    CreateTemplateRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/notification/templates`. Creates a template registry row keyed by `(code, locale)` UNIQUE — re-submission with the same key returns 409 Conflict. The template starts with NO versions; the admin must POST to `/:id/versions` to add content before the renderer can resolve `(templateCode, locale)`. `kind` is fixed at create-time and cannot be changed (a template authored as `email` cannot later be re-typed as `sms` — the body-shape invariants on `CreateTemplateVersionRequest` differ).',
    }),
  );

  registry.register(
    'TemplateResponse',
    TemplateResponseSchema.openapi({
      description:
        "Template registry row response — what `GET /api/v1/admin/notification/templates/:id` and the list endpoint return. `activeVersionId` is null when no version has been activated yet (the renderer returns 404 in that state); `activeVersionNumber` mirrors the active row's monotonic version integer; `latestVersionNumber` may exceed `activeVersionNumber` when newer versions exist but have not yet been activated (the typical draft-then-activate flow). `createdByUserId` is the soft-FK into `identity.users.id`.",
    }),
  );

  registry.register(
    'ListTemplatesQuery',
    ListTemplatesQuerySchema.openapi({
      description:
        "Query parameters for `GET /api/v1/admin/notification/templates`. Cursor-paginated (`limit` defaults to 50, capped at 200); optional exact-match filters on `kind`, `locale`, and `code` (code is exact-match — admin tooling uses it as a deep-link lookup, not a search filter). `cursor` is opaque to clients (a base64 envelope of the last row's sort key); pass back the value returned in `nextCursor` to advance.",
    }),
  );

  registry.register(
    'TemplatesListResponse',
    TemplatesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/notification/templates`. `templates` is ordered by `(code, locale)` ascending so two templates that share a code line up on adjacent locales — natural for the admin "which locales does this template cover" comparison view. `nextCursor` is null on the final page.',
    }),
  );

  registry.register(
    'CreateTemplateVersionRequest',
    CreateTemplateVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/notification/templates/:id/versions`. Adds a new version to a template; the service stamps the monotonic version number — never client-supplied. Per-`kind` body shape (joined off the template row by the controller before parsing): `email` requires `subject` + (`bodyMjml` OR `bodyHtml`); `sms` requires `bodyText` only; `push` requires `bodyText` + optional `subject` (push notification title); `in_app` requires `bodyText` + optional `subject`. `variablesSchema` is the declarative variable contract the renderer enforces — an empty array means the template accepts NO variables (any render request supplying any variable is rejected). `activate: true` flips the new version active atomically with the create.',
    }),
  );

  registry.register(
    'TemplateVersionResponse',
    TemplateVersionResponseSchema.openapi({
      description:
        'Template version row response — what `/versions` and `/versions/:n` return. `bodyHtml` may be the operator-supplied HTML (rare path) OR the MJML-compiled output (the dominant path — the service stamps it at version-create time so the renderer skips MJML compilation on every dispatch). SMS / push / in_app rows return null for the email-only fields. `isActive` tracks whether this version is currently the resolution target for `(templateCode, locale)`; only one row per template carries `isActive: true` at any time (TS-072-followup-11 enforces the single-active invariant via a partial unique index in addition to the service-layer check).',
    }),
  );

  registry.register(
    'TemplateVersionsListResponse',
    TemplateVersionsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/notification/templates/:id/versions`. Lists every version of the template ordered by `version` descending (newest first — natural for "what changed recently" review). All versions ever written are returned — there is no archive / delete (versions are append-only per CLAUDE.md §3.6 audit-trail discipline applied to template content).',
    }),
  );

  registry.register(
    'RenderTemplateRequest',
    RenderTemplateRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/internal/notification/render`. Shared-secret-pinned (`NOTIFICATION_RENDER_API_KEY` header) — only sibling services call this; clients never see it. The renderer looks up `(templateCode, locale)` → active version, validates `variables` against the version's `variablesSchema`, and returns the assembled message. Missing required variables → 422 Unprocessable Entity; unknown variables → 400 Bad Request; no active version → 404. `variables` map caps at 40 entries (matches the variable-schema declaration cap) and each value caps at 8 KiB to defeat bulk-exfil bucket abuse.",
    }),
  );

  registry.register(
    'RenderTemplateResponse',
    RenderTemplateResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/internal/notification/render`. `subject` is nullable for kinds that don't carry one (sms primarily); `bodyHtml` is populated for `email`; `bodyText` is populated for every kind that has a plain-text body (sms / push / in_app always; email when the template defines a plain-text alternative). `templateCode`, `locale`, and `version` echo so the dispatch consumer can log which template version actually rendered without a separate fetch (load-bearing for the TS-073 dispatch row's `templateVersionId` lineage column).",
    }),
  );

  registry.register(
    'ActivateTemplateVersionRequest',
    ActivateTemplateVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/notification/templates/:id/versions/:version/activate`. Flips `notification_templates.active_version_id` to the named version atomically. The body shape is degenerate today (`reason` is optional and audit-log-only) but is held as an explicit object so future flags (`scheduledActivationAt` for staged rollouts, `previousVersionRollbackWindow` for safe-revert) can land additively without a contract break.',
    }),
  );

  // Media-svc surfaces (TS-110 — PDD §21.5 image-upload pipeline + §7.2
  // service inventory entry #20; CLAUDE.md §3.4 file-upload pipeline;
  // registration follow-up TS-110-followup-14). Three endpoint clusters
  // back these schemas: (1) client signed-URL issuance at `POST /api/v1/
  // media/upload-urls` behind `AccessTokenGuard` — mints a single-use
  // direct-to-S3 URL + persists a `media_assets` row in `awaiting_upload`;
  // (2) client / admin asset metadata read at `GET /api/v1/media/assets/
  // :assetId` behind `AccessTokenGuard` (owner-scope check enforced at the
  // service layer per CLAUDE.md §3.2); (3) internal scan-event ingest at
  // `POST /api/v1/internal/media/assets/:assetId/events` pinned by shared
  // secret (mirrors the TS-026 KYC + TS-064 tier-snapshot + TS-073 dispatch
  // internal-call pattern) — the media-processor worker (TS-110-followup-1)
  // calls this surface to advance the row through magic-byte → ClamAV →
  // Sharp stages. Admin list at `GET /api/v1/admin/media/assets` behind
  // `AccessTokenGuard` with future per-permission gating `media:read`
  // deferred to TS-110-followup-9 once `PermissionGuard` lifts to
  // `packages/nest-auth` via TS-052-followup-11. Live S3 / ClamAV / Sharp
  // wiring is Phase-1 stub-only (TS-110-followup-2..4 land the live SDK
  // shims); the contract shape is invariant across stub-vs-live and the
  // `liveMode: boolean` field on the issuance + asset responses signals
  // which mode the service is running in. Per-kind size + MIME caps are
  // enforced at the service layer (allow-list per `MediaAssetKind`); the
  // contract caps `declaredSizeBytes` at the outer ceiling
  // (`MEDIA_MAX_SIZE_BYTES` = 200 MiB). The client MUST NOT trust the
  // declared MIME — magic-byte detection in the media-processor is
  // authoritative per CLAUDE.md §17.16. Internal scan-event ingest is
  // idempotent on `(assetId, eventKind)`; a replayed event returns the
  // existing row state without re-applying the transition. Free-text
  // `scanReason` crosses the wire on the asset response (admin triage) but
  // is bounded at `MEDIA_REASON_MAX_LENGTH` = 512 chars; sensitive PII
  // never lives in this field — the contract enforces a free-text cap, not
  // a categorical enum, because failure modes are operationally diverse
  // (ClamAV signature names, Sharp error messages, S3 error codes).
  registry.register(
    'MediaAssetKind',
    MediaAssetKindSchema.openapi({
      description:
        'Media asset kind — controls the per-kind size cap and the allowed MIME subset enforced at the service layer. Seven Phase-1 variants: `senior_photo` (requires senior consent per CLAUDE.md §12), `provider_profile_photo`, `provider_video_intro`, `memory_recipe_image`, `provider_document` (PDF — provider IDs, food handler certs, insurance proofs), `certification_evidence` (PDF or image — course completion evidence), `academy_lesson_attachment` (instructor-uploaded lesson asset). Mirrors the Prisma `media.media_asset_kind` enum. Future kinds (partner co-marketing assets, etc.) land additively per CLAUDE.md §4.1 forward-compatible migrations.',
    }),
  );

  registry.register(
    'MediaAssetStatus',
    MediaAssetStatusSchema.openapi({
      description:
        'Media asset lifecycle status. Seven-state machine: `awaiting_upload` (row minted; signed URL issued; bytes not yet PUT to S3), `uploaded` (S3 reports the object exists; media-processor has not yet inspected it), `scanning` (media-processor started magic-byte + ClamAV + Sharp work), `ready` (fully processed; safe to render — delivery URL non-null), `rejected` (content failed validation — magic-byte mismatch, virus hit, decompression bomb, format unsupported; bytes deleted, row preserved for audit), `failed` (pipeline encountered unexpected error — Sharp crash, ClamAV down; ops can retry via admin tooling), `expired` (signed URL expired before the client PUT completed). Mirrors the Prisma `media.media_asset_status` enum.',
    }),
  );

  registry.register(
    'MediaScanStatus',
    MediaScanStatusSchema.openapi({
      description:
        'Virus-scan outcome (independent of the overall asset status because the pipeline runs magic-byte + ClamAV + Sharp in sequence and each can fail independently). Four variants: `pending` (no scan attempted yet), `clean` (ClamAV cleared the file), `infected` (ClamAV signature match — bytes deleted from S3), `failed` (ClamAV could not finish — transient error, retryable). Mirrors the Prisma `media.media_scan_status` enum.',
    }),
  );

  registry.register(
    'MediaOwnerScopeKind',
    MediaOwnerScopeKindSchema.openapi({
      description:
        'Declared owner-scope kind. `media-svc` does not enforce referential integrity into other service schemas (CLAUDE.md §2.3 — soft FK), so the scope is identified at the contract layer by `(scopeKind, scopeId)` and the service layer is responsible for cross-service authorization gates (e.g. "is this user X a member of household Y?" — TS-141-followup-3). Five variants: `user` (provider headshots, video intros), `household` (senior photos, memory-recipe images), `senior` (a specific senior under a household), `provider` (a provider entity), `course` (a Cooking Academy course — instructor-uploaded lesson assets).',
    }),
  );

  registry.register(
    'MediaAssetEventKind',
    MediaAssetEventKindSchema.openapi({
      description:
        'Internal scan-event kind — the media-processor (or its Phase-1 stub) reports each pipeline stage via this discriminator. Eight variants: `upload_completed` (S3 has the bytes; transitions `awaiting_upload` → `uploaded`), `magic_byte_passed` (declared MIME matches detection — adds `detectedMime` + `sha256` + `sizeBytes` to the row; transitions `uploaded` → `scanning`), `magic_byte_failed` (declared MIME / extension mismatch — bytes deleted; transitions `uploaded` → `rejected`), `scan_passed` (ClamAV cleared the file), `scan_failed` (ClamAV reported infection — bytes deleted; transitions `scanning` → `rejected`), `process_passed` (Sharp resize / PDF render OK — adds dimensions / delivery-key), `process_failed` (Sharp crashed — decompression bomb, format unsupported; transitions to `rejected`), `expired` (signed URL expired before S3 saw the PUT; transitions `awaiting_upload` → `expired`). Mirrors the Prisma `media.media_asset_event_kind` enum.',
    }),
  );

  registry.register(
    'IssueUploadUrlRequest',
    IssueUploadUrlRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/media/upload-urls`. The client declares an intent to upload: `kind` (drives the per-kind MIME allow-list + size cap at the service layer), `declaredMime` (IANA-shaped type/subtype — NOT authoritative; magic-byte detection in the media-processor is the authoritative MIME per CLAUDE.md §17.16), `declaredSizeBytes` (bounded at `MEDIA_MAX_SIZE_BYTES` = 200 MiB at the contract layer; per-kind ceilings enforced server-side — 20 MiB images, 200 MiB video, 25 MiB PDFs), optional `declaredFileName` (capped at 256 chars to defeat header injection / metadata bloat), and `ownerScope` (the `(kind, id)` soft-FK pair the service uses for the cross-service authorization gate). The service mints a single-use signed URL targeting S3, persists a `media_assets` row in `awaiting_upload`, and returns the URL + required headers + expiry.',
    }),
  );

  registry.register(
    'RecordAssetEventRequest',
    RecordAssetEventRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/media/assets/:assetId/events`. The media-processor worker (or its Phase-1 stub) reports a pipeline-stage outcome. Idempotent on `(assetId, eventKind)` — replay of the same stage event returns the existing row state without re-applying the transition. `detectedMime` / `sha256` / `sizeBytes` are populated on `magic_byte_passed`; `width` / `height` / `deliveryKey` on `process_passed`; `reason` on any failure event. `occurredAt` is the producer-side ISO 8601 instant the stage completed (the service stamps the persistence wall-clock separately for audit).',
    }),
  );

  registry.register(
    'MediaAssetResponse',
    MediaAssetResponseSchema.openapi({
      description:
        "Outwards-facing media asset metadata row. Visible to the owner (provider / family) for assets in their scope and to admin staff with `media:read` once TS-110-followup-9 lifts the gate. `signedDeliveryUrl` is null until status is `ready` — the service mints a fresh short-lived URL per read (never persistently shareable per CLAUDE.md §3.4); when populated, `signedDeliveryUrlExpiresAt` carries the URL's wall-clock expiry. `liveMode: false` signals stub-mode (Phase-1 development without the AWS SDK); `liveMode: true` signals the live S3 SDK is wired (TS-110-followup-2..4). `sha256` is included for client-side dedup. The status-discriminated nullability shape (e.g. `scanReason` non-null on `rejected` / `failed`; `actualSizeBytes` + `sha256` non-null from `magic_byte_passed` onward; `deliveryKey` non-null from `process_passed` onward) mirrors the Prisma column nullability and is enforced by service-layer transitions, not by the contract — the contract carries the column-level nullability so the response shape is uniform across statuses.",
    }),
  );

  registry.register(
    'IssueUploadUrlResponse',
    IssueUploadUrlResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/media/upload-urls`. Carries the upload URL, required HTTP method (`PUT` for the standard S3 single-PUT shape; `POST` reserved for the eventual multipart-upload surface), required HTTP headers (HMAC token, content-type pin, etc. — capped at `MEDIA_REQUIRED_HEADERS_MAX` = 16 keys with value lengths capped at `MEDIA_REQUIRED_HEADER_VALUE_MAX_LENGTH` = 1024 chars), the asset metadata row in `awaiting_upload` state, and the URL expiry instant. The client uploads direct-to-S3 with the supplied method + headers; once S3 confirms the object exists, the media-processor (TS-110-followup-1) advances the row via the internal scan-event ingest surface. `liveMode` echoes the asset's `liveMode` for the caller's convenience.",
    }),
  );

  registry.register(
    'RecordAssetEventResponse',
    RecordAssetEventResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/media/assets/:assetId/events`. `outcome` is `applied` on first delivery of a given `(assetId, eventKind)` pair (the row transitioned) or `replayed` when the same pair has already been recorded (the row is returned unchanged, no second transition). The full `asset` shape is echoed so the caller learns the post-event row state without a second GET round-trip.',
    }),
  );

  registry.register(
    'ListMediaAssetsQuery',
    ListMediaAssetsQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/media/assets`. Cursor-paginated; `limit` defaults to `MEDIA_LIST_LIMIT_DEFAULT` = 50 and is capped at `MEDIA_LIST_LIMIT_MAX` = 200. Optional exact-match filters on `kind`, `status`, `ownerScopeKind`, and `ownerScopeId` — admin tooling uses these to narrow the queue when triaging rejected assets or auditing a specific owner\'s uploads. `cursor` is opaque to clients (a base64 envelope of the last row\'s sort key); pass back the value returned in `nextCursor` to advance. The list endpoint is gated by `media:read` once TS-110-followup-9 lifts the permission guard from "any admin" to the explicit permission.',
    }),
  );

  registry.register(
    'MediaAssetsListResponse',
    MediaAssetsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/media/assets`. `rows` is ordered by `createdAt` descending (newest-first — natural for the admin "what just came in" triage view). `nextCursor` is null on the final page; pass it back as `cursor=` to advance.',
    }),
  );

  // Admin preview resolution (TS-282-followup-5b) —
  // `GET /api/v1/admin/media/assets/resolve?id=…&id=…` on the API gateway,
  // gated `media:read`. It exists to close a live defect: TS-277a gates
  // ad-creative approval on an accessibility review (alt-text adequacy, WCAG
  // contrast, motion) while web-admin rendered `assetKeys.join(', ')` as
  // literal text, so the reviewer approved without seeing the image. The
  // gateway fans out one `GET /api/v1/media/assets/{id}` per key, bounded at
  // `ADMIN_MEDIA_RESOLVE_MAX` = 10 (the widest assetKey-bearing record on the
  // platform is an ad creative), and maps each into a per-key outcome rather
  // than failing the page — an unresolvable key must not blank a console.
  registry.register(
    'ResolveMediaAssetsQuery',
    ResolveMediaAssetsQuerySchema.openapi({
      description:
        "Query for `GET /api/v1/admin/media/assets/resolve`. Ids are supplied as REPEATED `id` parameters, not a comma-joined list: a legacy assetKey is unvalidated free text (columns predate the TS-282-followup-5a convention) and may itself contain a comma, so a delimiter would silently mangle one bad key into two bogus ones and lose the value the response echoes back. Bounded at `ADMIN_MEDIA_RESOLVE_MAX` = 10 ids per call, matching `AD_CREATIVE_ASSET_KEYS_MAX` so a review page never needs a second call and the gateway's fan-out is bounded by construction.",
    }),
  );

  registry.register(
    'ResolvedMediaAsset',
    ResolvedMediaAssetSchema.openapi({
      description:
        'The outcome of resolving one assetKey for an admin preview — a discriminated union on `outcome`, and the discrimination is the safety property. The defect this endpoint fixes is a reviewer approving what they cannot see; rendering nothing without saying WHY reproduces it. `ready` carries a short-lived signed delivery URL (minutes-scale expiry is correct on an admin page rendered per request for an authenticated human looking at it now — the contrast with the public convention of TS-282-followup-5c is deliberate). `not_ready` means the asset exists but is not renderable and carries the lifecycle `status`, because "we rejected these bytes" and "we have not looked at them yet" are different answers. `not_found` is the common case today — assetKey columns were free text before TS-282-followup-5a, so a key may never have referenced media-svc at all, and saying so lets a reviewer bounce a creative instead of rubber-stamping it. `restricted` means the asset\'s kind is not previewable on an admin console (senior photos, memory-recipe art, provider identity documents, certification evidence) and deliberately does NOT name the kind. `unavailable` means media-svc could not be asked — never conflated with non-existence. The shape carries NO `storageBucket` / `storageKey` / `deliveryKey` / `sha256` / owner ids: handing media-svc\'s storage layout to a browser-facing app to draw a picture is the mistake TS-282-followup-5a refused when it pinned assetKey to the asset id.',
    }),
  );

  registry.register(
    'ResolveMediaAssetsResponse',
    ResolveMediaAssetsResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/media/assets/resolve`. One `ResolvedMediaAsset` per DISTINCT requested id, in request order, each echoing its `assetKey` so a caller maps results back by key rather than by array position. Bounded by the same `ADMIN_MEDIA_RESOLVE_MAX` = 10 ceiling as the query.',
    }),
  );

  // Provider-discovery surfaces (TS-111 — PDD §7.2 search-svc / §8.5 search
  // indices / §14.1 provider discovery; PRD §6.3 provider discovery &
  // booking; registration follow-up TS-111-followup-6). Three endpoint
  // clusters back these schemas: (1) public search at
  // `POST /api/v1/search/providers` behind `AccessTokenGuard` — family-
  // portal provider discovery with text query + filters (tier / language /
  // specialty / dietary expertise / cuisine / certification / min rating) +
  // optional geo radius + sort + cursor pagination; (2) internal upsert
  // at `PUT /api/v1/internal/search/providers/:providerId` pinned by shared
  // secret (mirrors the TS-026 KYC + TS-064 tier-snapshot + TS-073 dispatch
  // + TS-110 media internal-call pattern) — the search-indexer worker
  // (TS-053) materialises a denormalised provider document from upstream
  // domain events and PUTs it here, idempotent on `sourceUpdatedAt`-based
  // newer-only overwrite semantics; (3) internal delete at
  // `DELETE /api/v1/internal/search/providers/:providerId` shared-secret-
  // pinned — hard remove from the index per PRD §10.7 provider suspension
  // / archive + CLAUDE.md §12 welfare-flag holds. Future per-permission
  // gating (`provider:search`) on the public surface lands with
  // TS-111-followup-5 once `PermissionGuard` lifts to `packages/nest-auth`
  // via TS-052-followup-11. Live `@elastic/elasticsearch` wiring is Phase-1
  // stub-only (TS-111-followup-1 lands the live SDK); the contract shape
  // is invariant across stub-vs-live and the `liveMode: boolean` field on
  // the search + upsert + delete responses signals which mode the service
  // is running in. Soft-FK discipline per CLAUDE.md §2.3 — every id field
  // on the doc is a plain string; the indexer keeps the doc in sync via
  // domain events (`provider.tier_changed`, `provider.profile_updated`,
  // `booking.completed` for ratings, etc.). Tier-aware boosting per PDD
  // §14.1 — Elite > Certified > Basic — is enforced in the search
  // backend, not the contract; the contract just carries the tier enum so
  // facet aggregates can group rows. The discovery snapshot read endpoint
  // (`GET /api/v1/internal/providers/:providerId/discovery-snapshot`) on
  // service-provider is the read-side companion the indexer fetches when
  // an upstream event fires — both the search-side upsert and the
  // provider-side snapshot land on the same denormalised doc shape so the
  // worker round-trip is one read → one PUT with no per-event payload
  // bloat.
  registry.register(
    'ProviderDiscoveryTier',
    ProviderDiscoveryTierSchema.openapi({
      description:
        'Provider tier on the discovery document. Three variants: `basic`, `certified`, `elite`. Mirrors the Prisma `provider.provider_tier` enum — the search-indexer worker (TS-053) projects this value verbatim from the source row. Tier-aware boosting per PDD §14.1 (Elite > Certified > Basic) lives in the search-backend, not the contract; the contract carries the enum so facet aggregates group rows correctly. Tier-3 Concierge households can only book Elite Concierge providers per CLAUDE.md §12 — that gate is enforced at the booking-svc layer, not the discovery surface (every authenticated user can search across all tiers; the booking write-path rejects the mismatch).',
    }),
  );

  registry.register(
    'ProviderDiscoveryStatus',
    ProviderDiscoveryStatusSchema.openapi({
      description:
        'Provider lifecycle status — mirrors the Prisma `provider.provider_status` enum. Five variants: `pending`, `in_review`, `active`, `suspended`, `archived`. Only `active` providers are surfaced in public discovery by default (omitting `filters.statuses` defaults the backend to `[active]`); the other states exist on the doc for admin / debug reads and so the indexer can re-project on a status transition (e.g. `active` → `suspended` from a welfare-flag hold per CLAUDE.md §12). Admin tooling and internal callers can pass an explicit `statuses` array on the search request to widen the result set.',
    }),
  );

  registry.register(
    'ProviderDiscoverySort',
    ProviderDiscoverySortSchema.openapi({
      description:
        'Sort strategy the family-portal picks at query time. Three variants: `relevance` (default — score-based ranking; with no text query the backend falls back to popularity = booking-count + rating composite), `rating` (descending by `ratingAverage` with `ratingCount` tie-break), `distance` (ascending by distance from `geo.center` — REQUIRES `geo` to be supplied, the contract `superRefine`s a 400 if absent). Tier-aware boosting applies on top of every sort — Elite > Certified > Basic — irrespective of the chosen strategy.',
    }),
  );

  registry.register(
    'ProviderDiscoveryDocument',
    ProviderDiscoveryDocumentSchema.openapi({
      description:
        "Denormalised provider document the search-indexer worker writes into Elasticsearch (or the Phase-1 in-memory stub). One doc per provider; `providerId` is the index document id. Soft-FK discipline per CLAUDE.md §2.3 — every id field is a plain string with no referential integrity; the indexer keeps the doc in sync via domain events. `centroid` is a pre-computed lat/lng pair derived from the provider's service-area polygon (PDD §8.5 / §14.1) — Phase-1 search uses centroid + radius, not polygon intersection; polygon-aware search lands alongside the live ES wiring (TS-111-followup-1). `ratingAverage` is null for providers with no reviews yet; `ratingCount` defaults to 0 — both are kept in sync from `booking.completed` event tallies (TS-053 + TS-061 follow-up). `sourceUpdatedAt` is the provider-side source-of-truth `updatedAt` and drives the indexer's newer-only overwrite semantics — re-indexing a doc with an older `sourceUpdatedAt` is a no-op (`outcome: 'unchanged'`).",
    }),
  );

  registry.register(
    'SearchProvidersRequest',
    SearchProvidersRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/search/providers`. No required fields — empty body returns the top results sorted by relevance (the public discovery landing page). `query` is the free-text search box capped at `PROVIDER_DISCOVERY_QUERY_MAX_LENGTH` = 256 chars. `filters` carries the typed-facet narrowing: tier / status / language / specialty / cuisine / dietary expertise / certification (each capped at `PROVIDER_DISCOVERY_FILTER_VALUES_MAX` = 16 values) + `minRating` (0–5) + `providerIds` (TS-215-followup-2 — membership check against the doc's `providerId`, capped at `PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX` = 24; used by the family-portal /favorites page to hydrate a page of favourites with their denormalised discovery docs in one round-trip). `geo` carries the radius search: `{ center: { latitude, longitude }, radiusKm }` with `radiusKm` capped at `PROVIDER_DISCOVERY_RADIUS_KM_MAX` = 500 km. `sort: 'distance'` requires `geo` to be supplied; the contract `superRefine`s a 400 at the gateway rather than a confusing 422 from the backend. Omitting `filters.statuses` defaults to `[active]` at the backend — internal / admin callers can widen by passing an explicit array. `limit` defaults to `PROVIDER_DISCOVERY_LIMIT_DEFAULT` = 20 (max `PROVIDER_DISCOVERY_LIMIT_MAX` = 100); `cursor` is opaque to clients.",
    }),
  );

  registry.register(
    'SearchProvidersResponse',
    SearchProvidersResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/search/providers`. `hits` is an array of `{ document, score, distanceKm }` triples — `score` is the backend-supplied relevance score (higher is better), `distanceKm` is the distance from `geo.center` in kilometres (null when no geo was supplied on the request). `facets` carries server-side aggregates over the unfiltered result set as facet pills next to the result list — each facet (tiers / languages / specialties / cuisines / certifications) is capped at `PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX` = 32 buckets; the rest roll into a synthetic `__other__` bucket the backend may emit. `totalEstimate` is the backend's best-effort count — Phase-1 stub returns the exact count; live ES will switch to `track_total_hits=10000` and may return a lower-bound estimate. `nextCursor` is null on the final page; pass it back as `cursor=` to advance. `liveMode: false` signals the in-memory stub backend; `liveMode: true` signals the live `@elastic/elasticsearch` SDK is wired (TS-111-followup-1). `searchId` is the correlation id of the best-effort `search.performed` analytics event this query emitted (TS-217-prep-4a); the family-portal echoes it on `search.result_clicked` (CTR-by-position) and `booking.created` (query→booking conversion) so the search-relevance dashboard can join the funnel back to the originating query — always present and non-null.",
    }),
  );

  // Search result-click ingest (TS-217-prep-4b). The family-portal reports a
  // click on a `/providers` result to `POST /api/v1/search/clicks`;
  // service-search server-stamps the actor and emits a best-effort
  // `search.result_clicked` event (CTR-by-position telemetry — never a
  // correctness-bearing write).
  registry.register(
    'RecordSearchClickRequest',
    RecordSearchClickRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/search/clicks`. The family-portal sends only the three correlation fields it observed in the results UI: `searchId` (the `SearchProvidersResponse.searchId` correlation token, TS-217-prep-4a), the clicked `providerId`, and the zero-based `position` (rank within the page the user saw, capped at `SEARCH_RESULT_CLICKED_POSITION_MAX` = 9999). The actor is server-stamped from the access-token context, never client-supplied (CLAUDE.md §3.2).',
    }),
  );

  registry.register(
    'RecordSearchClickResponse',
    RecordSearchClickResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/search/clicks`. `accepted: true` when the `search.result_clicked` event was durably appended to the outbox; `accepted: false` when the best-effort append was dropped (the click is still acknowledged with a 202 — telemetry loss never fails the request).',
    }),
  );

  registry.register(
    'UpsertProviderDocumentRequest',
    UpsertProviderDocumentRequestSchema.openapi({
      description:
        "Request body for `PUT /api/v1/internal/search/providers/:providerId`. The search-indexer worker (TS-053) calls this with the denormalised doc materialised from the source-of-truth provider row + companion materialisations (certifications, service-area centroid, booking-completion tallies). The path parameter `:providerId` MUST match `document.providerId`; the service rejects the request with a 422 if they disagree (defence against silent over-write). Idempotent on `sourceUpdatedAt`-based newer-only overwrite semantics — re-PUTting the same version is `outcome: 'unchanged'`; PUTting an older version is also `outcome: 'unchanged'` (the backend keeps the newer doc).",
    }),
  );

  registry.register(
    'UpsertProviderDocumentResponse',
    UpsertProviderDocumentResponseSchema.openapi({
      description:
        "Response body for `PUT /api/v1/internal/search/providers/:providerId`. `outcome` is `created` on first PUT for a provider id, `updated` when the PUT carries a newer `sourceUpdatedAt` than the indexed doc, or `unchanged` when the indexed doc already carries an equal-or-newer `sourceUpdatedAt`. `indexedAt` is the wall-clock instant the backend applied the write (set on every outcome, including `unchanged` — `unchanged` returns the original indexedAt unmodified). `liveMode` echoes the backend mode for the caller's ops visibility.",
    }),
  );

  registry.register(
    'DeleteProviderDocumentResponse',
    DeleteProviderDocumentResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/internal/search/providers/:providerId`. `outcome` is `deleted` on first delete for a provider id, or `not_found` when the index already has no doc for that id (idempotent — re-deleting a missing doc is a 200 with `not_found`, never a 404 — the welfare-flag hold path needs an unambiguous "the doc is gone, regardless of starting state" outcome). `deletedAt` is the wall-clock instant the backend removed the doc; null on `not_found` (no row was touched). `liveMode` echoes the backend mode.',
    }),
  );

  registry.register(
    'ProviderDiscoverySnapshotResponse',
    ProviderDiscoverySnapshotResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/internal/providers/:providerId/discovery-snapshot` on service-provider (the read-side companion to the search-svc upsert). service-provider exposes this endpoint so the search-indexer worker can fetch a fully-materialised `ProviderDiscoveryDocument` whenever an upstream domain event (`provider.tier_changed`, `provider.certification_*`) fires; the worker then PUTs the doc verbatim to service-search's internal upsert. Discriminated union on `kind`: `{ kind: 'found', document }` carries the full doc; `{ kind: 'not_found', providerId }` covers the case where the providerId no longer exists or has been soft-deleted — the indexer reads this as \"issue a delete instead of an upsert\" to keep the index in sync with provider lifecycle. The endpoint-as-snapshot pattern keeps event payloads minimal and the doc shape free to evolve in service-search + service-provider lockstep without bumping every event schema.",
    }),
  );

  // TS-200 — provider self-service profile edit surface.
  // `PUT /api/v1/providers/:providerId/profile` lets an active
  // provider update their bio, language / cuisine / dietary-expertise
  // tag arrays, and the dementia-sensitive flag. Self-service-first:
  // the authenticated user must own the provider row (the
  // `providers.user_id` foreign-key must match the access-token's
  // `sub`). Admin-override + permission gating (`provider:edit`) lands
  // as TS-200-followup-1 once `PermissionGuard` lifts to
  // `packages/nest-auth` via TS-052-followup-11. The four schemas
  // below register the supporting kind enum, the request body, the
  // richer `ProviderProfileRecord` projection (with tag arrays +
  // dementia-sensitive flag on top of the lean `ProviderRecord`), and
  // the response envelope. The matching `provider.profile_updated`
  // domain event is in `packages/contracts/src/events/provider.ts` —
  // the search-indexer treats it as a "re-fetch + re-project" trigger
  // via the discovery-snapshot read endpoint (no diff in payload, so
  // event size stays tiny + the source-of-truth stays single).
  registry.register(
    'ProviderProfileTagKind',
    ProviderProfileTagKindSchema.openapi({
      description:
        'Tag kind discriminator for the polymorphic `provider_profile_tags` table. Three variants — `language` (BCP-47 / ISO 639-1 specifier), `cuisine` (free-text cuisine identifier), `dietary_expertise` (free-text dietary skill identifier). Tags themselves are lowercase-alphanumeric + `-`/`_` separators capped at 48 chars; the platform does NOT keep a closed catalogue of tag values — providers supply any tag matching the regex, and the search index treats unfamiliar tags as long-tail. A future tag-suggestions surface (TS-200-followup-2) can layer typeahead on top without changing the wire shape.',
    }),
  );

  registry.register(
    'UpdateProviderProfileRequest',
    UpdateProviderProfileRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/providers/:providerId/profile` (TS-200). Full-replace semantics across every field: `bio` is a nullable scalar (`null` clears the bio; a string overwrites it); the three tag arrays are full-set replacements per kind (the server runs `DELETE WHERE provider_id = ? AND kind = ?` then bulk-inserts the new set inside one transaction so consumers see the resulting set atomically); `dementiaSensitive` is a boolean flag the family-portal search filters on. The request shape is `.strict()` and every field is required — the editor always sends the full intended state, keeping the contract close to PUT-shaped semantics (sender names the resource representation post-write) rather than PATCH-shaped (sender names the diff). Tag arrays are de-duped at the boundary via `superRefine`; duplicate values inside a single kind reject as 422 rather than silently collapsing.',
    }),
  );

  registry.register(
    'ProviderProfileRecord',
    ProviderProfileRecordSchema.openapi({
      description:
        "Richer provider record projection — the lean `ProviderRecord` shape plus the tag arrays + `dementiaSensitive` flag the TS-200 editor populates. Used by `PUT /api/v1/providers/:providerId/profile` (TS-200), `GET /api/v1/providers/:providerId/profile` (TS-200-followup-4 — returns the bare record on hit, 404 on missing / soft-deleted), and the `service-search` discovery-snapshot read companion once that surface migrates off the source-of-truth denormalisation. The lean `ProviderRecord` stays the projection for the application-submission flow + the existing `submitProviderApplication` response so downstream consumers there don't see drift.",
    }),
  );

  registry.register(
    'UpdateProviderProfileResponse',
    UpdateProviderProfileResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/providers/:providerId/profile` (TS-200). Wrapped in `{ profile: ... }` so the shape is forward-compatible with future side-payloads (e.g. a derived discovery snapshot for client-side cache pre-warm) without a v1 break. The `profile.updatedAt` reflects the post-write timestamp — clients can use it as an optimistic-concurrency token in a future If-Match-headered PUT (TS-200-followup-5).',
    }),
  );

  // Provider availability surface (TS-203 — PRD §7.3 / PDD §8.2).
  // `GET /api/v1/providers/me/availability-snapshot` returns the
  // authenticated user's materialised availability (recurring windows +
  // one-off blackout exclusions), or null when no schedule is on file.
  // `PUT /api/v1/providers/:providerId/availability` lets an active
  // provider declare their recurring weekly slots + date-keyed
  // exclusions. `DELETE /api/v1/providers/:providerId/availability`
  // clears every row in one shot (idempotent — a delete on an empty
  // schedule succeeds with both deleted-counts zero). Self-service-
  // first: the authenticated user must own the provider row (the
  // `providers.user_id` FK must match the access-token's `sub`).
  // Admin-override + permission gating lands as a follow-up once
  // `PermissionGuard` lifts to `packages/nest-auth` via TS-052-
  // followup-11. The `provider.availability_updated` domain event is
  // in `packages/contracts/src/events/provider.ts` — the search-
  // indexer treats it as a "re-fetch + re-project" trigger via the
  // discovery-snapshot read endpoint (no schedule detail in payload,
  // so event size stays tiny + the source-of-truth stays single).
  registry.register(
    'ProviderAvailabilityWeekday',
    ProviderAvailabilityWeekdaySchema.openapi({
      description:
        "Weekday literal (`sunday` .. `saturday`). Mirrors the `ProviderAvailabilityWeekday` Prisma enum (TS-203 migration). Lowercased English names — the family-portal's locale-aware rendering happens at the UI layer, not the contract layer.",
    }),
  );

  registry.register(
    'ProviderAvailabilityWindow',
    ProviderAvailabilityWindowSchema.openapi({
      description:
        "One recurring weekly window. Half-open `[startTime, endTime)` interval; `startTime` must be strictly less than `endTime`. Midnight-spanning windows are NOT supported — a chef declaring Saturday 22:00 → Sunday 02:00 splits the entry into two rows so the booking-svc availability gate's day-keyed lookup stays simple.",
    }),
  );

  registry.register(
    'ProviderAvailabilityException',
    ProviderAvailabilityExceptionSchema.openapi({
      description:
        'One date-keyed exclusion. The provider blocks "I am not available on YYYY-MM-DD" with a single row that disables ALL of that day\'s recurring windows. Partial-day blocks are not modelled in this phase; per-date overrides (e.g. "normally closed Sundays but open this Sunday") arrive with TS-203-followup-1.',
    }),
  );

  registry.register(
    'ProviderAvailabilitySummaryEntry',
    ProviderAvailabilitySummaryEntrySchema.openapi({
      description:
        'One resolved entry on the next-7-days availability projection used by the search-indexer (TS-053). The producer (service-provider\'s `getDiscoverySnapshot`) walks the recurring windows starting at the current day, drops dates covered by an exclusion row, and emits one entry per surviving window. Booked-time gaps are NOT applied here — the indexer does not see active bookings; the family-portal search treats availability as a "could be free" signal, not a "definitely free" guarantee.',
    }),
  );

  registry.register(
    'ProviderAvailabilitySummary',
    ProviderAvailabilitySummarySchema.openapi({
      description:
        'Next-7-days availability projection carried on the `ProviderDiscoveryDocument` (TS-053 / TS-203). The indexer treats `null` as "no schedule declared" and excludes the provider from the "available this week" filter; a non-null but `entries: []` value means "schedule declared but every recurring slot is blocked by exclusions". `generatedAt` is the producer wall-clock when the projection was materialised — stale projections still display, the booking-svc availability gate is the authoritative final check at booking-create time.',
    }),
  );

  registry.register(
    'ProviderAvailabilityRecord',
    ProviderAvailabilityRecordSchema.openapi({
      description:
        "Materialised availability shape returned by the snapshot GET + the PUT response. `windows` + `exceptions` are the source-of-truth rows; `updatedAt` is the most-recent write to either table (the service computes the max). Carries the provider's `timeZone` denormalised from the parent `providers` row so the editor can interpret HH:MM strings without a second fetch.",
    }),
  );

  registry.register(
    'ProviderAvailabilitySnapshotResponse',
    ProviderAvailabilitySnapshotResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/providers/me/availability-snapshot` (TS-203). `{ availability: null }` when the authenticated provider has not yet declared any windows; `{ availability: ProviderAvailabilityRecord }` otherwise. The null branch lets the editor render an empty-state placeholder without a 404 round-trip.',
    }),
  );

  registry.register(
    'UpdateProviderAvailabilityRequest',
    UpdateProviderAvailabilityRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/providers/:providerId/availability` (TS-203). Full-set replacement on both `windows` and `exceptions` — submitting empty arrays clears the schedule (equivalent to a DELETE on the resource). Cross-window overlap rejection runs at the boundary via `superRefine` — two windows on the same weekday whose `[startTime, endTime)` intervals overlap reject as 400 before any DB hit. Duplicate exception dates also reject at the boundary.',
    }),
  );

  registry.register(
    'UpdateProviderAvailabilityResponse',
    UpdateProviderAvailabilityResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/providers/:providerId/availability` (TS-203). Wrapped in `{ availability: ProviderAvailabilityRecord }` so the shape is forward-compatible with future side-payloads (e.g. the derived discovery snapshot for client-side cache pre-warm) without a v1 break.',
    }),
  );

  registry.register(
    'DeleteProviderAvailabilityResponse',
    DeleteProviderAvailabilityResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/providers/:providerId/availability` (TS-203). Always 200 — a delete on an already-empty schedule is a no-op success. `deletedWindowCount` + `deletedExceptionCount` carry the count of rows actually removed so the editor can surface a "no schedule was saved" hint when the user clicks delete on an empty schedule.',
    }),
  );

  // TS-206 — provider external-calendar-sync surface. Seven schemas pin
  // the wire shape of the Google Calendar connect / callback / snapshot /
  // sync / disconnect endpoints. NO event content + NO token material
  // crosses any of these — the OAuth scope is free/busy-only (ADR-0003)
  // and the refresh token lives only in the encrypted DB column. The
  // `provider.calendar_synced` domain event lives in
  // `packages/contracts/src/events/provider.ts`.
  registry.register(
    'ProviderCalendarProvider',
    ProviderCalendarProviderSchema.openapi({
      description:
        'External calendar provider (TS-206). Phase-1 ships `google` only; `icloud` (CalDAV) + `outlook` (Microsoft Graph) append with TS-206-followup-2.',
    }),
  );

  registry.register(
    'ProviderCalendarConnectionStatus',
    ProviderCalendarConnectionStatusSchema.openapi({
      description:
        'External-calendar connection health (TS-206). `connected` = refresh token held + last sync succeeded; `error` = the last free/busy pull failed (Google rejected the refresh token — the provider revoked access or the grant expired — reconnect required). A disconnected provider has no connection row at all.',
    }),
  );

  registry.register(
    'ProviderCalendarConnectionRecord',
    ProviderCalendarConnectionRecordSchema.openapi({
      description:
        'Materialised calendar-connection shape for one provider (TS-206). Carries NO secret material — the refresh token lives only in the encrypted DB column and never crosses this contract. `externalBusyCount` is the number of busy intervals currently mirrored.',
    }),
  );

  registry.register(
    'StartProviderCalendarConnectionResponse',
    StartProviderCalendarConnectionResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/providers/:providerId/calendar/google/connect` (TS-206). Returns the Google consent URL the client navigates the browser to; the `state` query param on that URL is an HMAC-signed, TTL-bounded token binding the providerId + actor (CSRF + identity).',
    }),
  );

  registry.register(
    'ProviderCalendarConnectionSnapshotResponse',
    ProviderCalendarConnectionSnapshotResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/providers/me/calendar-connection` (TS-206). `{ connection: null }` when the provider has not linked a calendar (or has no provider row yet); `{ connection: ProviderCalendarConnectionRecord }` once linked. The null branch lets the portal render the "Connect your calendar" empty state without a 404 round-trip.',
    }),
  );

  registry.register(
    'SyncProviderCalendarResponse',
    SyncProviderCalendarResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/providers/:providerId/calendar/sync` (TS-206). Reports the post-sync mirrored busy count + the sync timestamp so the portal can render "Last synced …".',
    }),
  );

  registry.register(
    'DisconnectProviderCalendarResponse',
    DisconnectProviderCalendarResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/providers/:providerId/calendar/google` (TS-206). Idempotent — a delete on an already-disconnected provider returns `disconnected: false` with `removedExternalBusyCount: 0`.',
    }),
  );

  // TS-202 — provider service-area surface. Nine schemas pin the wire
  // shape of `GET /api/v1/providers/me/service-areas-snapshot`,
  // `PUT /api/v1/providers/:providerId/service-areas`, and
  // `DELETE /api/v1/providers/:providerId/service-areas`, plus the
  // GeoJSON polygon primitive + the derived centroid / bounding-box
  // objects the search-indexer reads (TS-053-followup-3 → TS-210). The
  // `provider.service_areas_updated` domain event lives in
  // `packages/contracts/src/events/provider.ts` — the search-indexer
  // treats it as a "re-fetch + re-project" trigger via the discovery-
  // snapshot read endpoint (no geometry in the payload, so event size
  // stays tiny + the source-of-truth stays single).
  registry.register(
    'GeoPolygon',
    GeoPolygonSchema.openapi({
      description:
        'A GeoJSON `Polygon` (RFC 7946 §3.1.6). `coordinates[0]` is the exterior ring; subsequent rings are interior holes. Positions are `[longitude, latitude]` (GeoJSON X-then-Y order). Each ring is closed (first position repeats as last) with at least 4 positions. Winding order + self-intersection are NOT enforced at the contract layer — those checks land alongside the live Elasticsearch geo wiring (TS-210).',
    }),
  );

  registry.register(
    'GeoCentroid',
    GeoCentroidSchema.openapi({
      description:
        "Server-computed planar area-weighted centroid of a service-area polygon's exterior ring (TS-202). Named-field `{ latitude, longitude }` order (NOT GeoJSON tuple order). Phase-1 provider discovery uses centroid + radius scoring (PDD §14.1); the search-indexer reads this into `ProviderDiscoveryDocument.centroid` (TS-053-followup-3).",
    }),
  );

  registry.register(
    'GeoBoundingBox',
    GeoBoundingBoxSchema.openapi({
      description:
        'Server-computed axis-aligned bounding box of a service-area polygon (TS-202). `min*` ≤ `max*` is guaranteed by the producer. Used as a cheap pre-filter for the household-in-service-area gate before any polygon-intersection test (TS-210).',
    }),
  );

  registry.register(
    'ProviderServiceAreaInput',
    ProviderServiceAreaInputSchema.openapi({
      description:
        'One service area as supplied on a PUT (TS-202). `label` is optional (null / omitted = unlabelled); `polygon` is the only required field. The centroid + bounding box are derived server-side and are NOT client-supplied.',
    }),
  );

  registry.register(
    'ProviderServiceAreaRecord',
    ProviderServiceAreaRecordSchema.openapi({
      description:
        'The materialised shape for one persisted service area (TS-202). `polygon` round-trips the stored GeoJSON verbatim; `centroid` + `boundingBox` are the server-computed derivations the search-indexer consumes.',
    }),
  );

  registry.register(
    'ProviderServiceAreasSnapshotResponse',
    ProviderServiceAreasSnapshotResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/providers/me/service-areas-snapshot` (TS-202). `{ providerId: null, serviceAreas: null }` when the authenticated user has no provider row yet; `{ providerId, serviceAreas: [] }` for a provider with no areas drawn (the providerId is carried so the editor can PUT its first area without a second round-trip); `{ providerId, serviceAreas: [...] }` once at least one area is on file.',
    }),
  );

  registry.register(
    'UpdateProviderServiceAreasRequest',
    UpdateProviderServiceAreasRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/providers/:providerId/service-areas` (TS-202). Full-set replacement on `serviceAreas` — submitting an empty array clears every area (equivalent to a DELETE on the resource). Malformed polygons (open ring, < 4 positions, out-of-range lat/lng) reject at the boundary with 400 before any DB hit.',
    }),
  );

  registry.register(
    'UpdateProviderServiceAreasResponse',
    UpdateProviderServiceAreasResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/providers/:providerId/service-areas` (TS-202). Wrapped in `{ serviceAreas: ProviderServiceAreaRecord[] }` so the shape is forward-compatible with future side-payloads without a v1 break.',
    }),
  );

  registry.register(
    'DeleteProviderServiceAreasResponse',
    DeleteProviderServiceAreasResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/providers/:providerId/service-areas` (TS-202). Always 200 — a delete on an already-empty set is a no-op success. `deletedCount` carries the number of rows actually removed so the editor can surface a "no areas were saved" hint.',
    }),
  );

  // Provider pricing surface (TS-204 — PRD §5.1 / §5.2 / §7.2).
  // `GET /api/v1/providers/me/pricing-snapshot` returns the
  // authenticated provider's rate + the platform band for their tier
  // (null pricing when no provider row yet);
  // `GET /api/v1/providers/:providerId/pricing` returns the bare record
  // (404 on missing / soft-deleted) for the future booking-quote read;
  // `PUT /api/v1/providers/:providerId/pricing` sets the rate within
  // the platform-set tier band (out-of-band → 422). Self-service-first:
  // the authenticated user must own the provider row. The
  // `provider.pricing_updated` domain event lives in
  // `packages/contracts/src/events/provider.ts`.
  registry.register(
    'ProviderPricingBand',
    ProviderPricingBandSchema.openapi({
      description:
        'Platform-set min/max hourly-rate window for one marketplace tier (TS-204; PRD §5.2 / §7.2). Values in integer USD minor units (cents). The band is platform policy — the provider names a rate WITHIN this window; `service-provider` enforces it at write time (out-of-band → 422). Phase-1 bands live as a frozen constant (`PROVIDER_PRICING_BANDS`); moving them into a configurable `service_catalog` row is TS-204-followup-2.',
    }),
  );

  registry.register(
    'UpdateProviderPricingRequest',
    UpdateProviderPricingRequestSchema.openapi({
      description:
        "Request body for `PUT /api/v1/providers/:providerId/pricing` (TS-204). `hourlyRateMinor` is the provider's quoted rate in integer USD minor units (cents); the contract enforces only the absolute platform rail ($0.01–$10,000/hr) so re-tuning a per-tier band never forces a v1 break — the binding per-tier band is enforced server-side (out-of-band → 422). `currency` is an ISO-4217 code; Phase-1 USD-only is enforced server-side (422 on any other code) rather than baked into the contract.",
    }),
  );

  registry.register(
    'ProviderPricingRecord',
    ProviderPricingRecordSchema.openapi({
      description:
        'Materialised pricing shape for one provider (TS-204). `hourlyRateMinor` + `currency` are nullable and set/cleared together — a provider who has never named a rate reads null on both. `tier` + `band` are always present so the editor renders the allowed range and the future booking-quote path can re-validate the rate is still in-band. `updatedAt` is the `providers.updated_at` timestamp (a pricing PUT bumps it) and doubles as the optimistic-concurrency `If-Match` token.',
    }),
  );

  registry.register(
    'UpdateProviderPricingResponse',
    UpdateProviderPricingResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/providers/:providerId/pricing` (TS-204). Wrapped in `{ pricing: ... }` so the shape is forward-compatible with future side-payloads (e.g. a derived quote preview) without a v1 break.',
    }),
  );

  registry.register(
    'ProviderPricingSnapshotResponse',
    ProviderPricingSnapshotResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/providers/me/pricing-snapshot` (TS-204). `{ pricing: null }` when the authenticated user has no provider row yet; `{ pricing: ProviderPricingRecord }` otherwise. The null branch lets the editor render an empty-state placeholder without a 404 round-trip.',
    }),
  );

  // TS-060-followup-2 — service-catalog surface. Three schemas pin the
  // wire shape of `GET /api/v1/service-catalog` (authenticated read) and
  // `PUT /api/v1/admin/service-catalog/:kind` (super-admin upsert). Money
  // is integer USD minor units; the DB stores `Decimal(12,2)` and the
  // service crosses that boundary via the shared `money.ts` helpers.
  registry.register(
    'ServiceCatalogRecord',
    ServiceCatalogRecordSchema.openapi({
      description:
        'Materialised catalog row for one bookable service kind (TS-060-followup-2; PRD §5.4 / §6.3, PDD §8.2). `baseRateMinMinor`/`baseRateMaxMinor` are integer USD minor units bracketing the expected price; `durationMinutes` is the default visit length the booking-create quote will use. `active = false` soft-retires a kind from pickers without deleting the row. `requiredProviderTier` (TS-220) is the minimum provider tier needed to fulfil the kind — `null` = any tier; Tier-3 concierge experiences (PRD §6.6) carry `elite`. One row per `BookingServiceKind` (the `kind` is unique).',
    }),
  );

  registry.register(
    'ServiceCatalogListResponse',
    ServiceCatalogListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/service-catalog` (TS-060-followup-2). Wrapped in `{ entries: [...] }` so the shape is forward-compatible with future pagination metadata / filter facets without a v1 break. Entries are returned in `sortPosition` order.',
    }),
  );

  registry.register(
    'UpsertServiceCatalogEntryRequest',
    UpsertServiceCatalogEntryRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/admin/service-catalog/:kind` (TS-060-followup-2; admin tooling). Full-replace on the editable columns — the `kind` is the path param, never the body. Rate-band ends are integer USD minor units; an inverted band (`min > max`) is rejected at the boundary. `currency` accepts any 3-letter code on the wire; non-USD is rejected server-side with 422 until multi-currency lands (Phase 3). `requiredProviderTier` (TS-220) is the minimum provider tier — `null` for any tier, `elite` for Tier-3 concierge experiences.',
    }),
  );

  registry.register(
    'UpsertServiceCatalogEntryResponse',
    UpsertServiceCatalogEntryResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/admin/service-catalog/:kind` (TS-060-followup-2). Wrapped in `{ entry: ... }` so the shape is forward-compatible with future side-payloads (e.g. an audit-event id) without a v1 break.',
    }),
  );

  registry.register(
    'VisitPrepChecklistBooking',
    VisitPrepChecklistBookingSchema.openapi({
      description:
        'Booking projection inside the visit prep checklist (TS-208). Identifiers + scheduling + service kind — enough for the provider portal to render the visit card without re-fetching the booking row. The TS-205 `acceptWindowExpiresAt` field carries through so a still-pending booking can render its accept countdown alongside the prep info.',
    }),
  );

  registry.register(
    'VisitPrepChecklistSenior',
    VisitPrepChecklistSeniorSchema.openapi({
      description:
        'Senior operational projection inside the visit prep checklist (TS-208). Operational only — dietary/allergen/language tags + mobility level + dementia status; the senior intake\'s encrypted free-form notes (DOB, dietary/allergy/mobility/medical text) are deliberately excluded from the Phase-1 slice and land via a follow-up once the senior-consent table exists (TS-062-followup-3). `intakeCompletedAt` lets the provider surface a "family still needs to complete the intake" nudge.',
    }),
  );

  registry.register(
    'VisitPrepChecklistResponse',
    VisitPrepChecklistResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/bookings/:bookingId/prep-checklist` (TS-208 gateway BFF aggregator). Aggregates the booking row + the senior's operational intake + the per-senior memory recipes (capped at `VISIT_PREP_MEMORY_RECIPES_MAX = 24`, sorted requested-for-upcoming-visit first then by recency). Authz: actor must be the assigned provider for the booking; the gateway verifies via the actor's own `/api/v1/providers/me/profile-snapshot` lookup before issuing the internal aggregation calls. `generatedAt` is the gateway wall-clock time when the snapshot was assembled.",
    }),
  );

  registry.register(
    'InternalSeniorPrepSnapshotResponse',
    InternalSeniorPrepSnapshotResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/internal/seniors/:seniorId/prep-snapshot` (TS-208) on service-household. Pinned by the `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` shared-secret header (NetworkPolicy further restricts the route to in-cluster callers). Returns the senior's operational profile + the per-senior memory recipes the gateway BFF aggregates into the public `VisitPrepChecklistResponse`. Sole consumer today is api-gateway's prep-checklist endpoint.",
    }),
  );

  registry.register(
    'HouseholdMembership',
    HouseholdMembershipSchema.openapi({
      description:
        "One active household membership (TS-505d2-followup-5). `memberRole` mirrors service-household's `household_member_role` Postgres enum. Active means `removed_at IS NULL` and nothing else — the predicate every other read in service-household already uses; notably it does NOT require `accepted_at`.",
    }),
  );

  registry.register(
    'InternalHouseholdMembershipsResponse',
    InternalHouseholdMembershipsResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/internal/users/:userId/household-memberships` (TS-505d2-followup-5) on service-household. Pinned by the `HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY` shared-secret header (NetworkPolicy further restricts the route to in-cluster callers). Sole consumer is api-gateway's household-scope resolver, which turns the answer into the request's `tenantScope` before signing the trust envelope — no access token has ever carried a household scope, so this is what makes CLAUDE.md §3.2's household scoping reachable. An unknown user is a 200 with an empty list, never a 404. Carries household ids and member roles only: no names, no seniors, no addresses.",
    }),
  );

  registry.register(
    'InternalHouseholdBillingContactsRequest',
    InternalHouseholdBillingContactsRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/households/billing-contacts` (TS-042-followup-3a1) on service-household. A batch of household ids (1..200) to resolve to their paying members.',
    }),
  );

  registry.register(
    'HouseholdBillingContact',
    HouseholdBillingContactSchema.openapi({
      description:
        "The paying members of one household (TS-042-followup-3a1) — the user ids of every active `primary_payer`. `payerUserIds` is an array because the data model permits more than one payer and a couple sharing responsibility for a parent's care is a legitimate shape; returning all of them keeps the choice of who to tell with the caller, who knows what the message is. `family_observer` and `senior_user` members are excluded at the query, not left to the caller — a senior learning by email that their care is about to lapse for non-payment is a CLAUDE.md §12 dignity failure. Carries no names and no addresses: emails are resolved on a separate hop via `POST /api/v1/internal/identity/recipient-contacts`, so neither route alone yields a mailable identity.",
    }),
  );

  registry.register(
    'InternalHouseholdBillingContactsResponse',
    InternalHouseholdBillingContactsResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/households/billing-contacts` (TS-042-followup-3a1) on service-household. Pinned by the `HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY` shared-secret header (NetworkPolicy further restricts the route to in-cluster callers). This is the missing first hop of every family-facing billing notification: a subscription\'s `customer_id` is a `households.id` for the `family` customer group, and nothing on the platform could previously turn one into a person. A household with no active primary payer is ABSENT from `contacts`, never a row with an empty list — the `.min(1)` on `payerUserIds` makes that unrepresentable, because "nobody pays for this household" is an escalation for a human rather than a routine miss.',
    }),
  );

  registry.register(
    'InternalProviderBillingContactsRequest',
    InternalProviderBillingContactsRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/providers/billing-contacts` (TS-042-followup-3a1a) on service-provider. A batch of provider ids (1..200) to resolve to their owning accounts.',
    }),
  );

  registry.register(
    'ProviderBillingContact',
    ProviderBillingContactSchema.openapi({
      description:
        "The account that owns one provider (TS-042-followup-3a1a). `ownerUserId` is SINGULAR, unlike the household route's `payerUserIds` array, because `provider.providers.user_id` is `@unique` — at most one provider profile per identity user, enforced at the database. Mirroring the array would assert a plurality the schema forbids; if provider ownership ever becomes multi-user this field must become an array AND every caller be revisited, never widened silently. Carries no name and no address: emails are resolved on a separate hop via `POST /api/v1/internal/identity/recipient-contacts`, so neither route alone yields a mailable identity.",
    }),
  );

  registry.register(
    'InternalProviderBillingContactsResponse',
    InternalProviderBillingContactsResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/internal/providers/billing-contacts` (TS-042-followup-3a1a) on service-provider. Pinned by the `PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY` shared-secret header — its own secret rather than the discovery one, because a shared secret is a trust principal and the callers differ. The provider twin of the household billing-contacts hop: a subscription's `customer_id` is a `providers.id` for the `provider` customer group, and until this existed a provider whose card failed was counted `skipped_customer_group` by the dunning ladder and told nothing at all. No status filter is applied — a suspended, archived or soft-deleted provider can still hold a live subscription, and filtering here would make exactly that customer unreachable while looking like a clean empty result; deliverability is decided one hop later by identity. A provider id matching no row is ABSENT from `contacts`, never a row with a null owner.",
    }),
  );

  registry.register(
    'SearchRankingConfig',
    SearchRankingConfigSchema.openapi({
      description:
        'Search ranking configuration row (TS-211). Holds the per-region tier-weight multipliers consumed by service-search at query time to apply tier-aware boosting (PDD §14.1; Elite > Certified > Basic). One row keyed by `regionCode` — the canonical `global` row is seeded on first migration with Elite ×1.5 / Certified ×1.2 / Basic ×1.0 and acts as the fallback when a per-region row is absent.',
    }),
  );

  registry.register(
    'UpsertSearchRankingConfigRequest',
    UpsertSearchRankingConfigRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/internal/search/ranking-config/:regionCode` (TS-211). Idempotent — replaying the same body returns `unchanged` and leaves `updatedAt` untouched. `updatedByUserId` carries the actor attribution when the api-gateway BFF forwards from an authenticated admin actor (TS-211-followup-1).',
    }),
  );

  registry.register(
    'UpsertSearchRankingConfigResponse',
    UpsertSearchRankingConfigResponseSchema.openapi({
      description:
        'Response body for `PUT /api/v1/internal/search/ranking-config/:regionCode` (TS-211). Discriminated by `outcome` — `created` for a first write, `updated` for a weight change, `unchanged` for a byte-equal replay.',
    }),
  );

  registry.register(
    'GetSearchRankingConfigResponse',
    GetSearchRankingConfigResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/search/ranking-config/:regionCode` (TS-211). Discriminated union — `found` carries the row, `not_found` lets the api-gateway BFF (TS-211-followup-1) decide whether to surface a 404 to web-admin or fall back to the `global` row.',
    }),
  );

  registry.register(
    'ListSearchRankingConfigResponse',
    ListSearchRankingConfigResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/search/ranking-config` (TS-211). Sorted by `regionCode` so `global` consistently appears first. Used by web-admin (TS-211-followup-2) to render the full per-region matrix.',
    }),
  );

  registry.register(
    'DeleteSearchRankingConfigResponse',
    DeleteSearchRankingConfigResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/internal/search/ranking-config/:regionCode` (TS-211). The `global` row cannot be deleted — the service layer rejects with 422 + a guidance detail line. Per-region rows return `deleted` on first call, `not_found` on replay.',
    }),
  );

  registry.register(
    'SavedSearch',
    SavedSearchSchema.openapi({
      description:
        'Saved-search record (TS-215). A named snapshot of a `SearchProvidersRequest` body the family payer can re-run with one click. The owner is the authenticated actor; `seniorId` is optional. `lastRunAt` is null until the family invokes the run endpoint, then bumped on every rerun so the dashboard can surface the most recently used searches first.',
    }),
  );

  registry.register(
    'CreateSavedSearchRequest',
    CreateSavedSearchRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/saved-searches` (TS-215). The owner is server-derived from the authenticated request context; the client supplies a human label, the optional senior association, and the verbatim `SearchProvidersRequest` body to persist.',
    }),
  );

  registry.register(
    'UpdateSavedSearchRequest',
    UpdateSavedSearchRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/saved-searches/:id` (TS-215). Every editable field is optional; the empty-body case is rejected by the service layer. `seniorId: null` clears the association; absence leaves it untouched.',
    }),
  );

  registry.register(
    'SavedSearchesListResponse',
    SavedSearchesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/saved-searches` (TS-215). Server-controlled order: descending `lastRunAt` (nulls last) then descending `createdAt` so the most recently used searches surface first on the dashboard.',
    }),
  );

  registry.register(
    'RunSavedSearchResponse',
    RunSavedSearchResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/saved-searches/:id/run` (TS-215). The service layer bumps `lastRunAt` to the current wall-clock and echoes the refreshed row so the client can update its list without a second round-trip. The actual search hits are fetched by the client via the existing `POST /api/v1/search/providers` endpoint with the saved query body.',
    }),
  );

  registry.register(
    'GetSavedSearchResponse',
    GetSavedSearchResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/saved-searches/:id` (TS-215-followup-1). Used by the `/providers` page to hydrate its filter form from a stored query body when the family clicks "Run" on a saved search. Row-level ownership is enforced at the service layer; a caller asking for another actor’s row gets a 404 (same shape as "doesn’t exist") so the surface cannot be used to probe for foreign row ids.',
    }),
  );

  registry.register(
    'DeleteSavedSearchResponse',
    DeleteSavedSearchResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/saved-searches/:id` (TS-215). Idempotent — replaying after the row is gone returns `not_found` rather than a 404 from the gateway so the family-portal can collapse a duplicate-click without surfacing an error toast.',
    }),
  );

  registry.register(
    'FavoriteProvider',
    FavoriteProviderSchema.openapi({
      description:
        'Favorite-provider record (TS-215). Per-actor bookmark of a provider with an optional senior association so the family-portal can surface "providers we love for Mom" on the senior profile. Uniqueness is `(ownerUserId, providerId, seniorId)` — the same provider can be favourited once per senior (or once-without-senior) per actor.',
    }),
  );

  registry.register(
    'CreateFavoriteProviderRequest',
    CreateFavoriteProviderRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/favorite-providers` (TS-215). Idempotent on the `(providerId, seniorId)` tuple — replaying returns `unchanged`; differing `notes` causes an `updated` outcome.',
    }),
  );

  registry.register(
    'CreateFavoriteProviderResponse',
    CreateFavoriteProviderResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/favorite-providers` (TS-215). Discriminated by `outcome`: `created` for a first bookmark, `updated` for a notes-only change, `unchanged` for a byte-equal replay.',
    }),
  );

  registry.register(
    'FavoriteProvidersListResponse',
    FavoriteProvidersListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/favorite-providers` (TS-215). Server-controlled order: descending `createdAt`. The endpoint accepts optional `seniorId` + `providerId` query filters for the senior-profile lens and the heart-toggle state check on the provider-detail page.',
    }),
  );

  registry.register(
    'DeleteFavoriteProviderResponse',
    DeleteFavoriteProviderResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/favorite-providers/:id` (TS-215). Idempotent — replaying after the row is gone returns `not_found` rather than a 404 from the gateway so the family-portal can collapse a duplicate-click without surfacing an error toast.',
    }),
  );

  registry.register(
    'MySeniorStatus',
    MySeniorStatusSchema.openapi({
      description:
        'Senior lifecycle status (TS-214). Mirrors the `household.senior_status` Postgres enum. The directory surfaces every non-deleted senior regardless of status.',
    }),
  );

  registry.register(
    'MySeniorSummary',
    MySeniorSummarySchema.openapi({
      description:
        'One row in the family-portal "your loved ones" directory (TS-214). A lightweight projection — name, display name, status, parent household id. Sensitive intake (DOB, medical notes) is never in this shape; it stays behind the per-senior intake endpoint with its own decrypt boundary.',
    }),
  );

  registry.register(
    'MySeniorsResponse',
    MySeniorsResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/me/seniors` (TS-214). Resolves the actor's active household memberships → households → active seniors. Server-controlled order: ascending firstName, lastName, seniorId.",
    }),
  );

  // Senior family-observability consent (TS-238; CLAUDE.md §12). Per-senior
  // surface flags (photos / notes / location / health), default opt-out,
  // that gate what a `family_observer` may see. The primary payer + senior
  // end-user always see everything; the gate masks observers only.
  registry.register(
    'SeniorConsentSurface',
    SeniorConsentSurfaceSchema.openapi({
      description:
        "One family-observability consent surface (TS-238). `photos` = visit photo summaries + memory-recipe images; `notes` = wellness observation notes; `location` = geo check-in coordinates; `health` = the senior's health/medical profile (DOB, dementia stage, encrypted intake notes).",
    }),
  );

  registry.register(
    'SetSeniorConsentRequest',
    SetSeniorConsentRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/seniors/{seniorId}/consent` (TS-238). Full-replace of all four surface flags — the editor is a four-toggle form, so the client always sends the complete state. Authorised for the primary payer + the senior end-user only; a family observer gets 403.',
    }),
  );

  registry.register(
    'SeniorConsentResponse',
    SeniorConsentResponseSchema.openapi({
      description:
        "Response body for `GET` + `PUT /api/v1/seniors/{seniorId}/consent` (TS-238). The four persisted flags (default opt-out — all false until set) plus audit metadata (`updatedAt` / `updatedByUserId`, both null on the never-set default) and `canManage` — the authenticated caller's capability (true for the primary payer + senior end-user, false for a family observer). `canManage` is a UI hint; the PUT handler re-checks server-side.",
    }),
  );

  // Per-(senior × family-member) alert subscriptions (TS-234; PRD §6.4).
  // Each household member chooses which alert types they personally want
  // about a senior — keyed (seniorId, userId), unlike the per-senior
  // consent map above. Defaults: missedVisit + emergencyFlag on,
  // concerningObservation off. Channels are orthogonal (TS-073).
  registry.register(
    'SeniorAlertType',
    SeniorAlertTypeSchema.openapi({
      description:
        "One family-alert type (TS-234). `missedVisit` = a booked visit the provider did not show up for; `concerningObservation` = a concerning wellness-observation pattern (TS-236 detector; observer delivery gated at emission by the senior's `notes` consent); `emergencyFlag` = a welfare/emergency flag raised during a visit or by trust & safety.",
    }),
  );

  registry.register(
    'SetSeniorAlertPreferencesRequest',
    SetSeniorAlertPreferencesRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/seniors/{seniorId}/alert-preferences` (TS-234). Full-replace of all three alert-type flags — the editor is a three-toggle form, so the client always sends the complete state. Authorised for any active household member (the caller manages their own subscription); a non-member gets 403.',
    }),
  );

  registry.register(
    'SeniorAlertPreferencesResponse',
    SeniorAlertPreferencesResponseSchema.openapi({
      description:
        "Response body for `GET` + `PUT /api/v1/seniors/{seniorId}/alert-preferences` (TS-234). The three persisted flags plus `updatedAt` (null on the never-set default, where missedVisit + emergencyFlag are true and concerningObservation is false). Per-(senior, member) — each household member's own subscription. Channel selection (email/SMS/push) is governed separately by notification preferences (TS-073).",
    }),
  );

  registry.register(
    'SeniorPhoto',
    SeniorPhotoSchema.openapi({
      description:
        'A single consent-gated gallery photo (TS-232). Trimmed projection of a `ready` `senior_photo` media asset — id, short-lived signed delivery URL (minted fresh per read; never persistently shareable), intrinsic dimensions, optional original file name, upload time. Deliberately omits the asset internals (`ownerUserId` / `storageKey` / `sha256` / `scanStatus`) carried by `MediaAssetResponse`.',
    }),
  );

  registry.register(
    'SeniorPhotoGalleryQuery',
    SeniorPhotoGalleryQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/media/seniors/{seniorId}/photos` (media-svc) and `GET /api/v1/seniors/{seniorId}/photos` (gateway, TS-232). Cursor-paginated, newest-first.',
    }),
  );

  registry.register(
    'SeniorPhotoGalleryResponse',
    SeniorPhotoGalleryResponseSchema.openapi({
      description:
        'media-svc response for `GET /api/v1/media/seniors/{seniorId}/photos` (TS-232). The raw `ready` `senior_photo` list with cursor pagination. No consent gate — media-svc has no household-membership / consent knowledge; the gateway is the gate.',
    }),
  );

  registry.register(
    'FamilySeniorPhotoGalleryResponse',
    FamilySeniorPhotoGalleryResponseSchema.openapi({
      description:
        "Gateway response for `GET /api/v1/seniors/{seniorId}/photos` (TS-232). The consent-gated family-observability shape: `shared: true` when the caller may see photos (the senior turned the `photos` surface on, or the caller is the primary payer / senior end-user); `shared: false` (empty `photos`, null `nextCursor`) when a family observer's senior has not shared photos. Default opt-out (CLAUDE.md §12).",
    }),
  );

  registry.register(
    'FeaturedPlacement',
    FeaturedPlacementRecordSchema.openapi({
      description:
        'Featured-placement record (TS-207; PRD §7.2, §10.5; PDD §14.1). A scheduled window during which service-search applies a configurable score boost to a provider in discovery results. `regionCode: null` ⇒ every region; `tier: null` ⇒ every tier. The boost is resolved at query time in the ranking layer — never baked into the indexed document — because whether a provider is featured for a given search depends on the query region/tier and the wall-clock window.',
    }),
  );

  registry.register(
    'ScheduleFeaturedPlacementRequest',
    ScheduleFeaturedPlacementRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/search/featured-placements` (TS-207). Schedules a new featured window for a provider. `startsAt` must be strictly before `endsAt`. `regionCode` / `tier` omitted ⇒ the window applies in every region / to every tier. `createdByUserId` carries the actor attribution when the api-gateway BFF forwards from an authenticated super_admin actor.',
    }),
  );

  registry.register(
    'ScheduleFeaturedPlacementResponse',
    ScheduleFeaturedPlacementResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/search/featured-placements` (TS-207) — the created placement row.',
    }),
  );

  registry.register(
    'FeaturedPlacementsListResponse',
    FeaturedPlacementsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/search/featured-placements` (TS-207). Ordered by `startsAt` descending. Accepts optional `providerId` + `activeOnly` query filters and a bounded `limit`. Used by web-admin (TS-207) to render the scheduled-placements table.',
    }),
  );

  registry.register(
    'DeleteFeaturedPlacementResponse',
    DeleteFeaturedPlacementResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/internal/search/featured-placements/:placementId` (TS-207). Idempotent — replaying after the row is gone returns `not_found` rather than a 404 so the admin tooling can collapse a duplicate-click without surfacing an error.',
    }),
  );

  registry.register(
    'RecommendationSeniorProfile',
    RecommendationSeniorProfileSchema.openapi({
      description:
        'De-identified senior signal profile (TS-213; PRD §6.3). Languages + dietary categories + cuisine cues + a dementia-sensitive flag, assembled by the api-gateway from the senior intake + memory-profile preferences. Carries NO senior identifier — service-search scores anonymous signals only (CLAUDE.md §12).',
    }),
  );

  registry.register(
    'RecommendProvidersRequest',
    RecommendProvidersRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/search/recommendations` (TS-213). The de-identified senior signal profile + a bounded result count. Pinned by the `SEARCH_INDEX_*` shared secret — the api-gateway BFF forwards it after doing actor↔senior authz.',
    }),
  );

  registry.register(
    'RecommendationSignal',
    RecommendationSignalSchema.openapi({
      description:
        "One contributing signal in a recommendation's explainability trail (TS-213). `matchedValues` names the tags that matched (empty for the rating / popularity / tier quality baselines); `contribution` is the additive score amount — all signals' contributions sum to the recommendation `score`.",
    }),
  );

  registry.register(
    'RecommendedProvider',
    RecommendedProviderSchema.openapi({
      description:
        'A single scored match recommendation (TS-213): the denormalised provider document, the total score, and the explainability signal trail naming which senior-preference + provider-quality signals contributed.',
    }),
  );

  registry.register(
    'RecommendProvidersResponse',
    RecommendProvidersResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/search/recommendations` (TS-213). Top-N providers ordered by score descending (tie-broken by rating then providerId). `liveMode` marks the backend provenance.',
    }),
  );

  registry.register(
    'SeniorRecommendedProvidersResponse',
    SeniorRecommendedProvidersResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/seniors/:seniorId/recommended-providers` (TS-213; api-gateway BFF). Echoes the seniorId it was keyed on + `generatedAt`; carries the same scored recommendations as the internal surface minus the internal `liveMode` ops detail.',
    }),
  );

  // Dedicated culinary-concierge assignment (TS-222; PRD §5.1 Tier 3, §6.6;
  // PDD §10.6). Admin-gated create/replace + end + per-household history,
  // plus the family-portal "Your concierge" snapshot read. One active
  // assignment per household; reassignment ends the prior active row and
  // inserts a fresh one so the audit history is preserved (PDD §17).
  registry.register(
    'ConciergeAssignmentRecord',
    ConciergeAssignmentRecordSchema.openapi({
      description:
        'Dedicated culinary-concierge assignment record (TS-222). Links a household to a primary concierge + optional backup, both with display names captured at assignment time (no cross-service name resolution — CLAUDE.md §2.3). `status` is `active` (the current concierge — at most one active row per household) or `ended` (superseded / explicitly ended, retained for the audit trail). `endedAt` is null while active.',
    }),
  );

  registry.register(
    'CreateConciergeAssignmentRequest',
    CreateConciergeAssignmentRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/concierge/assignments` (TS-222). Assigns (or replaces) the dedicated concierge for a household. The backup concierge is optional but, when supplied, requires both the user id and display name and must be a different person from the primary. `assignedByUserId` carries the actor attribution the api-gateway stamps from the authenticated super_admin.',
    }),
  );

  registry.register(
    'CreateConciergeAssignmentResponse',
    CreateConciergeAssignmentResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/concierge/assignments` (TS-222) — the newly-created active assignment row. Any prior active assignment for the household has been ended in the same transaction.',
    }),
  );

  registry.register(
    'ConciergeAssignmentSnapshotResponse',
    ConciergeAssignmentSnapshotResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/concierge/assignments/me` (TS-222; family portal "Your concierge" card). The single active assignment for the actor\'s household (resolved from the token `tenantScope`), or `null` when the household has no dedicated concierge. No household id is supplied by the caller — the token is the household-membership trust boundary.',
    }),
  );

  registry.register(
    'ConciergeAssignmentsListResponse',
    ConciergeAssignmentsListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/concierge/assignments?householdId=…` (TS-222; admin). The household's assignment history ordered active-first then by `startedAt` descending. Powers the web-admin assignment surface.",
    }),
  );

  registry.register(
    'EndConciergeAssignmentResponse',
    EndConciergeAssignmentResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/concierge/assignments/:assignmentId` (TS-222; admin). Idempotent — `ended` when the active row was ended by this call, `already_ended` on replay, `not_found` when the id does not resolve.',
    }),
  );

  // Thread + thread-participant CRUD (TS-070-followup-2; PRD §6.7; PDD §8.2 +
  // §13.1). The authenticated metadata surface over `messaging.threads` +
  // `messaging.thread_participants`. The trust gate is the caller's own
  // participation row (CLAUDE.md §3.2); message bodies (Cassandra) + event-
  // driven auto-provisioning are the sibling TS-070-followup-1 / -3.
  registry.register(
    'ThreadParticipantRecord',
    ThreadParticipantRecordSchema.openapi({
      description:
        'A thread-participant membership row (TS-070-followup-2). `role` is `member` (read+write) / `observer` (read-only) / `concierge` / `moderator`. `lastReadMessageId` is the read-receipt cursor into the Cassandra message partition (PDD §8.3), null until the participant has read a message.',
    }),
  );

  registry.register(
    'ThreadRecord',
    ThreadRecordSchema.openapi({
      description:
        'Bare thread metadata (TS-070-followup-2). `kind` is `household` / `booking` / `concierge` / `peer_thread`. `householdId` is set on household/concierge (optionally booking); `bookingId` only on booking; both null on peer_thread. `archivedAt` is the soft-archive timestamp (null = active).',
    }),
  );

  registry.register(
    'ThreadWithParticipantsRecord',
    ThreadWithParticipantsRecordSchema.openapi({
      description:
        'Thread metadata plus its full participant list (TS-070-followup-2) — the detail-read shape returned by `GET /api/v1/threads/:threadId` and `POST /api/v1/threads`.',
    }),
  );

  registry.register(
    'CreateThreadRequest',
    CreateThreadRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/threads` (TS-070-followup-2). Creates a thread of `kind`, seeding the supplied participants. The authenticated creator is added implicitly as a `member` if not named. Per-kind id invariant: booking requires `bookingId`; household/concierge require `householdId`; peer_thread forbids both. Seeded participant userIds must be unique.',
    }),
  );

  registry.register(
    'CreateThreadResponse',
    CreateThreadResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/threads` (TS-070-followup-2) — the created thread with its seeded participant list.',
    }),
  );

  registry.register(
    'ThreadsInboxResponse',
    ThreadsInboxResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/threads/me` (TS-070-followup-2) — the caller's threads (every thread they participate in), newest membership first, each carrying the caller's own role + read cursor + a participant count.",
    }),
  );

  registry.register(
    'ThreadDetailResponse',
    ThreadDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/threads/:threadId` (TS-070-followup-2) — full thread detail with the participant list. The caller must be a participant; a non-participant gets a 404 (no thread-existence leak).',
    }),
  );

  registry.register(
    'AddThreadParticipantRequest',
    AddThreadParticipantRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/threads/:threadId/participants` (TS-070-followup-2) — `{ userId, role }`. The caller must hold a posting role for the thread kind (a read-only observer cannot change the roster).',
    }),
  );

  registry.register(
    'AddThreadParticipantResponse',
    AddThreadParticipantResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/threads/:threadId/participants` (TS-070-followup-2). Idempotent on the roster — `added` for a new membership, `already_present` when the user was already a participant (role left unchanged).',
    }),
  );

  registry.register(
    'RemoveThreadParticipantResponse',
    RemoveThreadParticipantResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/threads/:threadId/participants/:userId` (TS-070-followup-2). Idempotent — `removed` when the membership was deleted, `not_present` on replay / no-op.',
    }),
  );

  // Concierge custom-request / service-request submission (TS-223; PRD §6.6;
  // PDD §10.6). Family submits a structured service request under one of the
  // PRD §6.6 request kinds; service-concierge persists a ticket, routes it to
  // the household's active dedicated concierge, and stamps a per-kind SLA.
  registry.register(
    'ConciergeTicketRecord',
    ConciergeTicketRecordSchema.openapi({
      description:
        'Concierge ticket record (TS-223). A submitted service request — its kind, lifecycle status, free-text subject + body, optional structured fields (requestedDate / partySize / theme), the SLA deadline, the routed concierge (`assignedToUserId`, null when unassigned), and escalation path. `status` is `assigned` when the household had an active dedicated concierge at submission, otherwise `open`.',
    }),
  );

  registry.register(
    'SubmitConciergeRequestRequest',
    SubmitConciergeRequestRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/concierge/requests` (TS-223). Submits a concierge service request for the actor's household (resolved from the token `tenantScope` — no household id crosses the wire). `kind` is restricted to the family-submittable PRD §6.6 catalog (custom request, holiday dinner, birthday experience, grocery stocking, tea social, museum outing, memory meal). `subject` + `body` are required; `requestedDate` (YYYY-MM-DD), `partySize`, and `theme` are optional structured fields.",
    }),
  );

  registry.register(
    'SubmitConciergeRequestResponse',
    SubmitConciergeRequestResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/concierge/requests` (TS-223) — the newly-created ticket. Routed to the household's active dedicated concierge when one exists (`status=assigned`); otherwise queued unassigned (`status=open`) for the ops console. The SLA deadline is `now + the per-kind policy hours`.",
    }),
  );

  registry.register(
    'ConciergeTicketsListResponse',
    ConciergeTicketsListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/concierge/requests/me` (TS-223; family portal). The household's submitted concierge requests ordered newest-first, so the portal can show each request's status + SLA.",
    }),
  );

  // Concierge ops console (TS-224; PRD §10.6; PDD §10.6). The back-office
  // surface for working the ticket queue TS-223 fills: an SLA-ordered queue,
  // ticket-level status transitions, escalation actions, and an append-only
  // internal-notes timeline. Permission-gated on `concierge:read` (reads) /
  // `concierge:write` (mutations).
  registry.register(
    'ConciergeTicketNoteRecord',
    ConciergeTicketNoteRecordSchema.openapi({
      description:
        'Append-only internal note on a concierge ticket (TS-224). Authored by the acting ops staff member (`authorUserId` from the verified token). Notes are never edited or deleted — an internal audit trail of ops activity (CLAUDE.md §3.6 spirit).',
    }),
  );

  registry.register(
    'ConciergeOpsTicketsListResponse',
    ConciergeOpsTicketsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/tickets` (TS-224; admin ops queue). Tickets across every household ordered by SLA proximity (soonest deadline first). With no `status` filter, returns the non-terminal tickets ("what needs attention"). Bounded by `limit`; no cursor at Phase-1 volume.',
    }),
  );

  registry.register(
    'ConciergeOpsTicketDetailResponse',
    ConciergeOpsTicketDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/tickets/:ticketId` (TS-224; admin). The full ticket plus its internal-notes timeline (oldest-first). 404 when the id does not resolve or the row is soft-deleted.',
    }),
  );

  registry.register(
    'TransitionConciergeTicketRequest',
    TransitionConciergeTicketRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/tickets/:ticketId/transition` (TS-224). Moves the ticket to `targetStatus` (must be allowed from the current status per the transition matrix — a disallowed move is a 409). The optional `note` is appended to the internal-notes timeline.',
    }),
  );

  registry.register(
    'TransitionConciergeTicketResponse',
    TransitionConciergeTicketResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/tickets/:ticketId/transition` (TS-224) — the updated ticket.',
    }),
  );

  registry.register(
    'EscalateConciergeTicketRequest',
    EscalateConciergeTicketRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/tickets/:ticketId/escalate` (TS-224). Sets the routing `escalationPath` (one of the actionable targets — concierge_lead / ops_manager / trust_safety / emergency_on_call) and moves the ticket to `escalated`. Escalating a terminal (resolved / canceled) ticket is a 409. The optional `note` records the escalation rationale.',
    }),
  );

  registry.register(
    'EscalateConciergeTicketResponse',
    EscalateConciergeTicketResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/tickets/:ticketId/escalate` (TS-224) — the updated ticket.',
    }),
  );

  registry.register(
    'AddConciergeTicketNoteRequest',
    AddConciergeTicketNoteRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/admin/concierge/tickets/:ticketId/notes` (TS-224). Appends a free-text internal note to the ticket's notes timeline.",
    }),
  );

  registry.register(
    'AddConciergeTicketNoteResponse',
    AddConciergeTicketNoteResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/tickets/:ticketId/notes` (TS-224) — the appended note.',
    }),
  );

  // Concierge scheduled events (TS-227; PRD §5.1 Tier 3 "social outings ·
  // event dining", §6.6; PDD §10.6). The fulfilment side of a concierge
  // request: the concrete booked restaurant reservation / cultural event /
  // group outing, optionally linked to its originating ticket.
  // Permission-gated on `concierge:read` (list) / `concierge:write` (schedule
  // + update). `externalProvider` is the Phase-3 OpenTable / museum adapter
  // seam (Phase-1 default `manual`).
  registry.register(
    'ConciergeScheduledEventRecord',
    ConciergeScheduledEventRecordSchema.openapi({
      description:
        'Concierge scheduled-event record (TS-227). A concrete booked experience fulfilling a Tier-3 household request — a restaurant reservation, cultural event, or group outing — with venue, scheduled start/end timestamps, party size, lifecycle status, and a booking-source seam (`externalProvider` = manual / opentable / museum, with `externalReference` carrying the confirmation number). `ticketId` links to the originating concierge ticket when the event fulfils a family request, or null for a concierge-initiated event.',
    }),
  );
  registry.register(
    'ScheduleConciergeEventRequest',
    ScheduleConciergeEventRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/scheduled-events` (TS-227). Schedules a new event for a household (`householdId` required — the ops actor is global-scoped). When `ticketId` is supplied the service verifies the ticket belongs to the same household. `status` defaults to `proposed`; a concierge may schedule directly as `confirmed`. `externalProvider` defaults to `manual`. When `scheduledEnd` is supplied it must be after `scheduledStart`.',
    }),
  );
  registry.register(
    'ScheduleConciergeEventResponse',
    ScheduleConciergeEventResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/scheduled-events` (TS-227) — the newly-scheduled event.',
    }),
  );
  registry.register(
    'UpdateConciergeEventRequest',
    UpdateConciergeEventRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/concierge/scheduled-events/:eventId` (TS-227). A partial update; at least one field is required. Nullable fields accept `null` to clear. `kind` is not editable. A `status` change must be an allowed transition from the current status (a disallowed move is a 409); a terminal (completed / canceled) event rejects all edits.',
    }),
  );
  registry.register(
    'UpdateConciergeEventResponse',
    UpdateConciergeEventResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/concierge/scheduled-events/:eventId` (TS-227) — the updated event.',
    }),
  );
  registry.register(
    'ConciergeScheduledEventsListResponse',
    ConciergeScheduledEventsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/scheduled-events` (TS-227; admin). The matching events ordered by `scheduledStart` ascending (soonest first). Filterable by household / originating ticket / status / kind / upcoming-only. Bounded by `limit`; no cursor at Phase-1 volume.',
    }),
  );

  // Transportation coordination (TS-226; PRD §5.1 Tier 3 "transportation
  // coordination", §6.6; PDD §10.6). The concierge fulfilment surface for a
  // Tier-3 household's rides — pickup / dropoff / scheduled time / lifecycle,
  // permission-gated on `concierge:read` (list) / `concierge:write` (schedule
  // + update). `externalProvider` is the Phase-3 Uber Health / Lyft Health
  // adapter seam (Phase-1 default `manual`); the inbound ride-status webhook
  // is shared-secret-pinned (not gateway-exposed) and mirrors vendor driver
  // state onto the domain lifecycle.
  registry.register(
    'ConciergeTransportationRequestRecord',
    ConciergeTransportationRequestRecordSchema.openapi({
      description:
        'Concierge transportation-request record (TS-226). A concrete booked ride fulfilling a Tier-3 household request — pickup / dropoff addresses, a scheduled pickup time, an optional purpose + rider, lifecycle status, and a booking-source seam (`externalProvider` = manual / uber_health / lyft_health, with `externalReference` carrying the vendor ride id and `externalStatus` the raw vendor status the webhook last mirrored). `ticketId` links to the originating concierge ticket when the ride fulfils a family request, or null for a concierge-initiated ride.',
    }),
  );
  registry.register(
    'ScheduleConciergeTransportationRequest',
    ScheduleConciergeTransportationRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/transportation` (TS-226). Arranges a new ride for a household (`householdId` required — the ops actor is global-scoped). When `ticketId` is supplied the service verifies the ticket belongs to the same household. `status` defaults to `requested`; a concierge may schedule directly as `scheduled`. `externalProvider` defaults to `manual`.',
    }),
  );
  registry.register(
    'ScheduleConciergeTransportationResponse',
    ScheduleConciergeTransportationResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/transportation` (TS-226) — the newly-arranged ride.',
    }),
  );
  registry.register(
    'UpdateConciergeTransportationRequest',
    UpdateConciergeTransportationRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/concierge/transportation/:requestId` (TS-226). A partial update / override / cancel; at least one field is required. Nullable fields accept `null` to clear. `householdId` and `externalProvider` are not editable. A `status` change must be an allowed transition from the current status (a disallowed move is a 409); a terminal (completed / canceled) ride rejects all edits. Set `status: canceled` to cancel.',
    }),
  );
  registry.register(
    'UpdateConciergeTransportationResponse',
    UpdateConciergeTransportationResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/concierge/transportation/:requestId` (TS-226) — the updated ride.',
    }),
  );
  registry.register(
    'ConciergeTransportationListResponse',
    ConciergeTransportationListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/transportation` (TS-226; admin). The matching rides ordered by `scheduledPickupAt` ascending (soonest first). Filterable by household / originating ticket / status / provider / upcoming-only. Bounded by `limit`; no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'ConciergeRideStatusWebhookEvent',
    ConciergeRideStatusWebhookEventSchema.openapi({
      description:
        'Inbound ride-status webhook body (TS-226) a ride-hailing vendor POSTs to the shared-secret-pinned `POST /internal/concierge/transportation/ride-events` as a ride progresses. Matched against the stored request by (`externalProvider`, `externalReference`); the raw `externalStatus` is mapped onto a domain status via the per-vendor adapter (an unrecognised value is stored verbatim but leaves the domain status unchanged). `manual` is rejected — a manually-coordinated ride has no vendor edge.',
    }),
  );
  registry.register(
    'ConciergeRideStatusWebhookResponse',
    ConciergeRideStatusWebhookResponseSchema.openapi({
      description:
        'Response body for `POST /internal/concierge/transportation/ride-events` (TS-226) — the processing outcome (`applied` / `unchanged` / `unrecognized_status` / `already_terminal` / `not_found`) plus the resulting domain status (null when no request matched).',
    }),
  );

  // Emergency concierge assistance (TS-225; PRD §5.1 Tier 3; PDD §16.1,
  // §20.5). A distinct family channel from the TS-223 custom request — it
  // always opens a high-severity `emergency_assistance` ticket (escalated on
  // the `emergency_on_call` path, 1-hour SLA) and pages the on-call
  // supervisor via PagerDuty. Reachable by any household (no Tier-3 hard
  // gate — a safety surface).
  registry.register(
    'TriggerEmergencyAssistanceRequest',
    TriggerEmergencyAssistanceRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/concierge/emergency` (TS-225). Triggers emergency concierge assistance. `category` is a fixed triage signal (medical / safety / urgent_need / other); the optional `note` adds free-text context that becomes the ticket body (NOT forwarded to PagerDuty — the page links the responder to the ops-console ticket for detail).',
    }),
  );
  registry.register(
    'TriggerEmergencyAssistanceResponse',
    TriggerEmergencyAssistanceResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/concierge/emergency` (TS-225) — the created high-severity ticket (`kind='emergency_assistance'`, `status='escalated'`, `escalationPath='emergency_on_call'`, the 1-hour SLA). Routed to the household's active dedicated concierge when one exists. Whether the PagerDuty page was dispatched is an internal observability concern, not a family-facing field — the ticket is always created and the concierge team always notified.",
    }),
  );

  // Trust & Safety incident intake (TS-301a; PRD §10.14; PDD §16.1). The
  // family/senior "Report a concern" surface — opens a trust_safety incident
  // (TS-300) scoped to the household resolved from the token (no household
  // id crosses the wire). The response is a deliberately minimal receipt:
  // severity / SLA / triage status are internal operational facts, not
  // filer-facing fields.
  registry.register(
    'ReportConcernRequest',
    ReportConcernRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/trust-safety/incidents` (TS-301a). Files a concern: `category` (welfare / safety / billing / conduct) + a required free-text `description` (stored on the incident; never carried on events) + an optional `seniorId` naming the senior the concern is about. The household is resolved from the token scope, never the body.',
    }),
  );
  registry.register(
    'AdminReportConcernRequest',
    AdminReportConcernRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/trust-safety/incidents` (TS-301b) — a concierge filing a concern ON BEHALF OF a household. This is the ONLY intake shape that carries `householdId` in the body, which is why it is a separate route gated on `concierge:write` (re-checked downstream) rather than a variant of the filer-facing schema, where a body household is rejected outright. Neither shape accepts a `providerId`: a self-asserted provider id would let a reporter pin a concern on another provider, so provider reports anchor on the verified reporter id instead.',
    }),
  );
  registry.register(
    'ReportConcernReceipt',
    ReportConcernReceiptSchema.openapi({
      description:
        'The filer-facing receipt (TS-301a) — the incident reference id (what support needs on a follow-up call), the category echo, and when the concern was opened. Severity, SLA deadline, and triage status are deliberately NOT exposed to the filer.',
    }),
  );
  registry.register(
    'ReportConcernResponse',
    ReportConcernResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/trust-safety/incidents` (TS-301a, 201) — the minimal receipt.',
    }),
  );

  // Operator incident queue + detail (TS-303c2d). The read surface TS-300's
  // partial SLA index was cut for. Summary/detail split on the same PHI line
  // as the mandated-reporter queue: `description` is a family's free-text
  // account of a named senior and rides the detail read only.
  registry.register(
    'TrustSafetyIncidentSummary',
    TrustSafetyIncidentSummarySchema.openapi({
      description:
        "An incident as it appears in the operator queue (TS-303c2d). Carries NO `description` and NO `resolutionNotes` — the filer's free-text account of what happened to a named senior belongs on the detail read, not in a 200-row list (CLAUDE.md §3.9). `hasMandatedReporterCase` is a boolean rather than the case itself: the queue needs to show that an incident is in the statutory pathway (and therefore cannot be closed) without dragging a second confidential record into a list.",
    }),
  );
  registry.register(
    'TrustSafetyIncidentRecord',
    TrustSafetyIncidentRecordSchema.openapi({
      description:
        'The full operator view of one incident (TS-303c2d) — the queue summary plus `description` and `resolutionNotes`. Gated on `trust_safety:write` rather than `:read` precisely because of those two fields.',
    }),
  );
  registry.register(
    'ListTrustSafetyIncidentsQuery',
    ListTrustSafetyIncidentsQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/admin/trust-safety/incidents` (TS-303c2d). `status` absent returns every incident that is not `resolved` — the queue means live work; `?status=resolved` reaches the closed ones. The `householdId` / `seniorId` / `providerId` filters are the 360-view scrolls (PDD §16.1), each with its own index.',
    }),
  );
  registry.register(
    'TrustSafetyIncidentListResponse',
    TrustSafetyIncidentListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/trust-safety/incidents` (TS-303c2d). Ordered by `slaDueAt` ascending — the partial index `trust_safety_incidents_unresolved_sla_idx` exists for exactly this scan.',
    }),
  );
  registry.register(
    'TrustSafetyIncidentResponse',
    TrustSafetyIncidentResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/trust-safety/incidents/{incidentId}` (TS-303c2d).',
    }),
  );

  // Mandated-reporter workflow (TS-303b; PRD §10.14, §11.4; PDD §16.1, §16.4;
  // CLAUDE.md §12). Ops-only, gated on `trust_safety:write` at the gateway and
  // re-checked in the service. Opening a case IS the act of classifying an
  // incident as suspected elder abuse — there is no `suspectedAbuse` flag in
  // any of these shapes and nothing derives the classification from category
  // or severity, because auto-routing would manufacture statutory filings.
  // The `*Notes` fields carry PHI: persisted, authorised ops reads only, never
  // on an event or a log line.
  registry.register(
    'OpenMandatedReporterCaseRequest',
    OpenMandatedReporterCaseRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/admin/trust-safety/mandated-reporter/cases` (TS-303b) — route an incident into the per-state statutory pathway for suspected elder abuse. `stateCode` is the senior's state of residence, supplied by the operator: service-trust-safety cannot read service-household's tables to derive it, and which state's law governs is a human determination regardless. Idempotent — `incident_id` is UNIQUE, so a retry returns the existing case rather than starting a second statutory clock.",
    }),
  );
  registry.register(
    'AdvanceMandatedReporterCaseRequest',
    AdvanceMandatedReporterCaseRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/trust-safety/mandated-reporter/cases/{caseId}/transitions` (TS-303b). `to` omits `screening` by construction (nothing transitions back into the birth state). `filingReference` is required when `to = "filed"`. `to = "filing_prep"` is rejected with 422 unless compliance has VERIFIED that state\'s jurisdiction kit — the platform does not author elder-abuse reporting law, so an unchecked state blocks filing preparation rather than proceeding on guessed agency details. `to = "signed_off"` is rejected with 409 when the actor is the operator who opened the case (four-eyes, backstopped by a DB CHECK).',
    }),
  );
  registry.register(
    'MandatedReporterCaseRecord',
    MandatedReporterCaseRecordSchema.openapi({
      description:
        "Ops-facing mandated-reporter case record (TS-303b). Unlike the filer-facing intake receipt this is a full operational view — the audience is a trust & safety operator who needs the statutory deadline, the determination, and the signoff state to do the work. `statutoryDueAt` is null when the state's window is not yet established, which is itself the signal that the jurisdiction kit needs compliance attention.",
    }),
  );
  registry.register(
    'MandatedReporterCaseResponse',
    MandatedReporterCaseResponseSchema.openapi({
      description:
        'Response body for the mandated-reporter case open (201) and transition (200) routes (TS-303b).',
    }),
  );
  // Case queue (TS-303c2a) — the collection read the operator console opens
  // on. Separate summary shape from the detail record: the queue drops the
  // PHI-bearing `determinationNotes` / `reviewerNotes`, because a list does
  // not need a named senior's abuse narrative and sending 200 of them widens
  // the blast radius for nothing.
  registry.register(
    'MandatedReporterCaseSummary',
    MandatedReporterCaseSummarySchema.openapi({
      description:
        "A mandated-reporter case as it appears in the operator queue (TS-303c2a). Deliberately omits `determinationNotes` / `reviewerNotes` — the free-text account of a named senior's suspected abuse lives on the detail read only (CLAUDE.md §3.9). Everything an operator triages on is here: the jurisdiction, how the statutory clock stands, whether it has been filed, and who has touched it.",
    }),
  );
  registry.register(
    'ListMandatedReporterCasesQuery',
    ListMandatedReporterCasesQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/admin/trust-safety/mandated-reporter/cases` (TS-303c2a). `status` is an exact filter; when ABSENT the service returns every case that is not `signed_off`, because the queue means live work. `?status=signed_off` reaches the closed ones explicitly, so nothing is unreachable.',
    }),
  );
  registry.register(
    'MandatedReporterCaseListResponse',
    MandatedReporterCaseListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/trust-safety/mandated-reporter/cases` (TS-303c2a). Ordered by `statutoryDueAt` ascending with NULLS FIRST, then `openedAt` ascending — a null deadline is not "no deadline" but "nobody has established this state\'s statutory window", which is the case most at risk of being missed, so it sorts to the top rather than ageing quietly at the bottom.',
    }),
  );
  registry.register(
    'ResolveIncidentRequest',
    ResolveIncidentRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/trust-safety/incidents/{incidentId}/resolution` (TS-303b) — the first and only path in the platform that closes a trust & safety incident. `resolutionNotes` is required: an incident on this surface does not get closed with a shrug. The handler calls the never-auto-close gate first, so an incident with a mandated-reporter case that has not been signed off returns 409 (CLAUDE.md §12).',
    }),
  );
  registry.register(
    'ResolveIncidentResponse',
    ResolveIncidentResponseSchema.openapi({
      description:
        'Response body for the incident-resolution route (TS-303b, 200) — the incident id, its now-terminal status, and when it closed.',
    }),
  );

  // Per-state mandated-reporter workflow kit (TS-303c1; PDD §16.4 "mandated
  // reporter laws by state — workflow kit per state"). The table ships EMPTY
  // and every row starts unverified: the platform does not author
  // elder-abuse reporting law, and an unchecked state blocks filing
  // preparation rather than proceeding on guessed agency details.
  registry.register(
    'MandatedReporterJurisdictionRecord',
    MandatedReporterJurisdictionRecordSchema.openapi({
      description:
        'A state\'s mandated-reporter workflow kit (TS-303c1) — the receiving agency, hotline, portal, statutory window, whether the platform is a mandated or permissive reporter, and the statute the determination rests on. `verified` is the load-bearing field: FALSE means compliance has not reviewed the row against primary sources, and the service refuses to advance any case in that state to `filing_prep`. `platformRole: "undetermined"` is a to-do for compliance, not a finding that no duty exists.',
    }),
  );
  registry.register(
    'MandatedReporterJurisdictionResponse',
    MandatedReporterJurisdictionResponseSchema.openapi({
      description: 'Response body for the jurisdiction upsert and verification routes (TS-303c1).',
    }),
  );
  registry.register(
    'MandatedReporterJurisdictionListResponse',
    MandatedReporterJurisdictionListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/trust-safety/mandated-reporter/jurisdictions` (TS-303c1). `?unverifiedOnly=true` narrows to the compliance backlog — the states where the workflow is not yet usable.',
    }),
  );
  registry.register(
    'UpsertMandatedReporterJurisdictionRequest',
    UpsertMandatedReporterJurisdictionRequestSchema.openapi({
      description:
        'Request body for `PUT .../jurisdictions/{stateCode}` (TS-303c1). Every field is optional so a partially-researched state can be saved in progress. `verified` is deliberately NOT settable here — attesting that a row is correct is a separate act with its own route, attribution, and audit action, and folding it in would let an attestation ride along on an unrelated edit. Editing any substantive field of an already-verified row CLEARS `verified`: the attestation covered the old values, not the new ones.',
    }),
  );
  registry.register(
    'SetMandatedReporterJurisdictionVerificationRequest',
    SetMandatedReporterJurisdictionVerificationRequestSchema.openapi({
      description:
        'Request body for `POST .../jurisdictions/{stateCode}/verification` (TS-303c1). `verified: false` is a first-class operation, not an oversight — reporting law changes by legislative session, and a state whose statute has moved must be pulled out of service (blocking filing prep) rather than left asserting a stale window.',
    }),
  );

  // Tier-3 onboarding "white-glove kickoff" (TS-228; PRD §5.1 Tier 3; PDD
  // §10.6). A checklist-driven workflow guiding a new Tier-3 household through
  // the kickoff: a 30-minute concierge call, senior-preference deep-dive,
  // family expectation-setting, assign dedicated concierge, schedule the first
  // chef visit, confirm household access. The step set is a frozen template;
  // the rollup `status` derives from the steps (`canceled` is sticky-terminal).
  // Admin surfaces gate on `concierge:read` / `concierge:write`; the family
  // `/me` read is household-scoped + read-only.
  registry.register(
    'ConciergeOnboardingStepRecord',
    ConciergeOnboardingStepRecordSchema.openapi({
      description:
        'One checklist step on a Tier-3 onboarding (TS-228). `title` + `description` are projected from the frozen step template (not stored). `status` is `pending` / `completed` / `skipped`; `completedAt` + `completedByUserId` are set only when completed.',
    }),
  );
  registry.register(
    'ConciergeOnboardingRecord',
    ConciergeOnboardingRecordSchema.openapi({
      description:
        'Tier-3 onboarding summary (TS-228). The rollup `status` (`not_started` / `in_progress` / `completed` / `canceled`) is derived from the steps except `canceled` which is sticky-terminal. `stepsTotal` / `stepsCompleted` (completed OR skipped) let a list row render a progress bar without the full steps array. `kickoffScheduledAt` is the scheduled time of the 30-minute kickoff call.',
    }),
  );
  registry.register(
    'ConciergeOnboardingDetailRecord',
    ConciergeOnboardingDetailRecordSchema.openapi({
      description:
        'Full Tier-3 onboarding detail (TS-228) — the summary record plus its ordered checklist steps. Returned by create / get / update / update-step and the family `/me` read.',
    }),
  );
  registry.register(
    'CreateConciergeOnboardingRequest',
    CreateConciergeOnboardingRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/onboardings` (TS-228). Opens a kickoff checklist for a household (`householdId` required — the ops actor is global-scoped); seeds the six frozen template steps as `pending`. `kickoffScheduledAt` + `notes` are optional. A household may have at most one active onboarding (a second create is a 409).',
    }),
  );
  registry.register(
    'CreateConciergeOnboardingResponse',
    CreateConciergeOnboardingResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/onboardings` (TS-228) — the newly-created onboarding with its seeded checklist steps.',
    }),
  );
  registry.register(
    'GetConciergeOnboardingResponse',
    GetConciergeOnboardingResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/onboardings/:onboardingId` (TS-228) — the full onboarding + steps. 404 when the id does not resolve or the row is soft-deleted.',
    }),
  );
  registry.register(
    'ConciergeOnboardingsListResponse',
    ConciergeOnboardingsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/onboardings` (TS-228; admin). The matching onboardings (summaries, no steps) newest-first, filterable by household / status. Bounded by `limit`; no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'UpdateConciergeOnboardingRequest',
    UpdateConciergeOnboardingRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/concierge/onboardings/:onboardingId` (TS-228). Edits the onboarding-level fields; at least one is required. `kickoffScheduledAt` + `notes` accept `null` to clear. `status` may only be set to `canceled` (the explicit terminal action; the other statuses derive from the steps). A canceled onboarding rejects all edits (409).',
    }),
  );
  registry.register(
    'UpdateConciergeOnboardingResponse',
    UpdateConciergeOnboardingResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/concierge/onboardings/:onboardingId` (TS-228) — the updated onboarding + steps.',
    }),
  );
  registry.register(
    'UpdateConciergeOnboardingStepRequest',
    UpdateConciergeOnboardingStepRequestSchema.openapi({
      description:
        "Request body for `PATCH /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey` (TS-228). Advances (or re-opens) one checklist step. Setting `status='completed'` stamps the step's `completedAt` + `completedByUserId`; any other status clears them. `notes` accepts `null` to clear. The onboarding's rollup status recomputes after the change.",
    }),
  );
  registry.register(
    'UpdateConciergeOnboardingStepResponse',
    UpdateConciergeOnboardingStepResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey` (TS-228) — the updated onboarding + steps.',
    }),
  );
  registry.register(
    'MyConciergeOnboardingResponse',
    MyConciergeOnboardingResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/concierge/onboarding/me` (TS-228; family portal read-only progress card). The household's onboarding (with steps), resolved from the token `tenantScope`, or `null` when the household has no onboarding. No household id is supplied by the caller — the token is the household-membership trust boundary.",
    }),
  );

  // TS-229 — Tier-3 weekly enrichment summary. The dedicated concierge writes a
  // short weekly narrative (visit highlights / wellness signals / social
  // engagement) per household; the family dashboard surfaces the published
  // summaries with a per-week permalink. draft → published → archived (family
  // sees only published); one summary per household per Monday-anchored week.
  // Admin surfaces gate on `concierge:read` / `concierge:write`; the family
  // `/me` reads are household-scoped + read-only.
  registry.register(
    'ConciergeEnrichmentSummaryRecord',
    ConciergeEnrichmentSummaryRecordSchema.openapi({
      description:
        'A Tier-3 weekly enrichment summary (TS-229). `weekStartDate` is the Monday anchoring the week. `status` is `draft` / `published` / `archived` — the family sees only `published`. `publishedAt` + `publishedByUserId` are set on publish; `archivedAt` on archive. The three narrative sections (`visitHighlights` / `wellnessSignals` / `socialEngagement`) plus an optional `additionalNotes` carry the concierge’s write-up.',
    }),
  );
  registry.register(
    'CreateConciergeEnrichmentSummaryRequest',
    CreateConciergeEnrichmentSummaryRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/concierge/enrichment-summaries` (TS-229). Opens a new weekly summary as a `draft` (`householdId` required — the ops actor is global-scoped). `weekStartDate` must be a Monday; the three narrative sections are required; `additionalNotes` is optional. A household may have at most one non-deleted summary per week (a second create for the same week is a 409).',
    }),
  );
  registry.register(
    'CreateConciergeEnrichmentSummaryResponse',
    CreateConciergeEnrichmentSummaryResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/concierge/enrichment-summaries` (TS-229) — the newly-created draft summary.',
    }),
  );
  registry.register(
    'GetConciergeEnrichmentSummaryResponse',
    GetConciergeEnrichmentSummaryResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/enrichment-summaries/:summaryId` (TS-229; admin) — the full summary. 404 when the id does not resolve or the row is soft-deleted.',
    }),
  );
  registry.register(
    'ConciergeEnrichmentSummariesListResponse',
    ConciergeEnrichmentSummariesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/concierge/enrichment-summaries` (TS-229; admin). The matching summaries newest-week-first, filterable by household / status. Bounded by `limit`; no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'UpdateConciergeEnrichmentSummaryRequest',
    UpdateConciergeEnrichmentSummaryRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/concierge/enrichment-summaries/:summaryId` (TS-229). Edits the narrative fields and/or transitions the status; at least one field is required. `additionalNotes` accepts `null` to clear. `status` drives the lifecycle — publishing stamps `publishedAt` + `publishedByUserId`, archiving stamps `archivedAt`; an unsupported transition is a 409.',
    }),
  );
  registry.register(
    'UpdateConciergeEnrichmentSummaryResponse',
    UpdateConciergeEnrichmentSummaryResponseSchema.openapi({
      description:
        'Response body for `PATCH /api/v1/admin/concierge/enrichment-summaries/:summaryId` (TS-229) — the updated summary.',
    }),
  );
  registry.register(
    'MyConciergeEnrichmentSummariesResponse',
    MyConciergeEnrichmentSummariesResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/concierge/enrichment-summaries/me` (TS-229; family dashboard read). The household's PUBLISHED summaries newest-week-first, resolved from the token `tenantScope`. No household id is supplied by the caller — the token is the household-membership trust boundary. `summaries: []` when the household has none.",
    }),
  );
  registry.register(
    'MyConciergeEnrichmentSummaryResponse',
    MyConciergeEnrichmentSummaryResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/concierge/enrichment-summaries/me/:summaryId` (TS-229; family permalink). One PUBLISHED summary scoped to the caller’s household, or `null` when the id does not resolve to a published summary for this household (a foreign / draft / archived id is indistinguishable from a missing one — no oracle).',
    }),
  );

  registry.register(
    'WellnessSummaryHousehold',
    WellnessSummaryHouseholdSchema.openapi({
      description:
        'One active household in the monthly wellness-summary batch (TS-235; internal, worker-only). Carries the household’s active seniors (id, name, status, the senior’s `notes` consent flag) + active recipients (userId + membership role). Households with no senior to summarise or nobody to notify are filtered out server-side.',
    }),
  );
  registry.register(
    'InternalWellnessSummaryHouseholdsResponse',
    InternalWellnessSummaryHouseholdsResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/wellness-summary/households` (TS-235; shared-secret-pinned, in-cluster). Cursor-paginated batch of active households the wellness-summary worker iterates. `nextCursor` is the last household id when a further page may exist, else null.',
    }),
  );
  registry.register(
    'InternalRecipientContactsRequest',
    InternalRecipientContactsRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/identity/recipient-contacts` (TS-235; shared-secret-pinned). A batch of `identity.users.id` values the worker needs email + account status for (the household batch carries no emails).',
    }),
  );
  registry.register(
    'InternalRecipientContactsResponse',
    InternalRecipientContactsResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/identity/recipient-contacts` (TS-235). Resolves recipient userIds to `{ userId, email, status }`. A userId with no matching user row is absent from `contacts`; the worker skips non-`active` accounts.',
    }),
  );
  registry.register(
    'WellnessObservationMetricSummary',
    WellnessObservationMetricSummarySchema.openapi({
      description:
        'Per-scale roll-up of a senior’s wellness observations over the window (TS-235): latest reading + mean (one decimal) + visit count per wellness scale. All-null when the scale was never recorded.',
    }),
  );
  registry.register(
    'InternalSeniorWellnessObservationSummaryResponse',
    InternalSeniorWellnessObservationSummaryResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/bookings/households/:householdId/seniors/:seniorId/wellness-observation-summary` (TS-235; shared-secret-pinned). The compact monthly roll-up the worker folds into the email — headline numbers per scale, not the full TS-231 per-visit chart series.',
    }),
  );

  // Ad-campaign admin surface (TS-271a; PRD §10.9; PDD §18.1, §8.2). The first
  // authenticated surface on service-ads: create / list / detail / edit a
  // campaign with its creatives + targeting rules, set budget / dates / status,
  // and advance a creative through its review lifecycle. Permission-gated on
  // `ads:read` (reads) / `ads:write` (mutations). Platform-wide marketing-admin
  // inventory (no per-household tenant axis). Money crosses as integer minor
  // units (`budgetMinor`) + currency, never a float (CLAUDE.md §4.1).
  registry.register(
    'AdCampaignRecord',
    AdCampaignRecordSchema.openapi({
      description:
        'Ad-campaign record (TS-271a) — an advertiser-bound, budget-bound campaign. Carries the operator-facing name, advertiser kind (partner / provider / internal house ad) + soft-FK advertiser id, lifecycle status, optional budget cap (`budgetMinor` integer cents + currency; null = uncapped), and the optional delivery window (`startAt` / `endAt`). Shallow — no nested creatives / rules; use the campaign-detail endpoint for the full aggregate.',
    }),
  );
  registry.register(
    'CreateAdCampaignRequest',
    CreateAdCampaignRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/ads/campaigns` (TS-271a). Creates a campaign, optionally with its initial creatives + targeting rules (applied in one transaction). `status` defaults to `draft`. `advertiserId` is required for a partner / provider campaign and must be null for an internal house ad. When both dates are present, `endAt` must be after `startAt`.',
    }),
  );
  registry.register(
    'UpdateAdCampaignRequest',
    UpdateAdCampaignRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/ads/campaigns/:campaignId` (TS-271a). A partial update; at least one field is required. Nullable fields (`advertiserId`, `budgetMinor`, `startAt`, `endAt`) accept `null` to clear. A `status` change must be an allowed transition (a disallowed move is a 409). `advertiserKind` is not editable.',
    }),
  );
  registry.register(
    'UpdateAdCreativeStatusRequest',
    UpdateAdCreativeStatusRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/ads/campaigns/:campaignId/creatives/:creativeId` (TS-271a) — advance a creative through its review lifecycle (draft → pending_review → approved / rejected / archived). The full approval + accessibility workflow lands in TS-277.',
    }),
  );
  registry.register(
    'ListAdCampaignsQuery',
    ListAdCampaignsQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/ads/campaigns`. Filter by `status` / `advertiserKind`. Bounded by `limit` (default 50, max 200); no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'AdCampaignResponse',
    AdCampaignResponseSchema.openapi({
      description:
        'Single-campaign envelope (`{ campaign }`) returned by the create / update endpoints.',
    }),
  );
  registry.register(
    'AdCampaignDetailResponse',
    AdCampaignDetailResponseSchema.openapi({
      description:
        'Campaign-detail envelope (`{ campaign }` with its nested creatives + decoded targeting rules) returned by `GET /api/v1/admin/ads/campaigns/:campaignId`.',
    }),
  );
  registry.register(
    'AdCampaignsListResponse',
    AdCampaignsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/ads/campaigns` — the matching campaigns ordered by `createdAt` descending.',
    }),
  );
  registry.register(
    'AdCreativeResponse',
    AdCreativeResponseSchema.openapi({
      description:
        'Single-creative envelope (`{ creative }`) returned by the creative-status PATCH endpoint.',
    }),
  );

  // Static-pages CMS admin surface (TS-284; PRD §10.11; PDD §19.2). Create a
  // page shell, append append-only `page_versions`, and `publish` a version
  // live (stamp `effectiveAt` + move the page head). Authoring is gated on
  // `content:edit`, the publish lever on `content:publish`, reads on
  // `content:read` (PDD Appendix B). Platform-wide content-staff inventory (no
  // per-household tenant axis). Prior versions remain individually addressable
  // for compliance (the `/legal/{slug}/v/{versionId}` web route is TS-284-followup-1).
  registry.register(
    'ContentStatus',
    ContentStatusSchema.openapi({
      description:
        'Publication lifecycle of a content page — mirrors the `ContentStatus` Prisma enum (PDD §19). `draft` (authoring; not served) / `published` (live) / `archived` (retired; retained for history).',
    }),
  );
  registry.register(
    'PageVersionRecord',
    PageVersionRecordSchema.openapi({
      description:
        'An append-only saved revision of a page (TS-284). Carries the per-version title + rendered body, the assigned monotonic `versionNo`, the authoring staff `createdBy`, and `effectiveAt` (null until the version is published; a published-then-superseded version keeps its historical `effectiveAt`). Never updated in place — each save is a new row.',
    }),
  );
  registry.register(
    'PageRecord',
    PageRecordSchema.openapi({
      description:
        'Static / marketing page record (TS-284) — the live editorial entity. Carries the unique slug, lifecycle status, editorial title, and the `currentVersionId` soft pointer to the live `page_versions` row (null for a page with no version / never published). Shallow — use the page-detail endpoint for the version history.',
    }),
  );
  registry.register(
    'PageDetail',
    PageDetailSchema.openapi({
      description:
        'Page record WITH its version history (newest-first), returned by `GET /api/v1/admin/content/pages/:pageId` — the page-editor hydration.',
    }),
  );
  registry.register(
    'CreatePageRequest',
    CreatePageRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/pages` (TS-284). Creates a page shell in `draft` with no version. `slug` must be lowercase kebab-case and unique across pages (a collision is a 409). The first renderable revision is added via the append-version endpoint.',
    }),
  );
  registry.register(
    'CreatePageVersionRequest',
    CreatePageVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/pages/:pageId/versions` (TS-284). Appends a new revision; `versionNo` is assigned server-side (monotonic per page). The version is NOT live on creation — `effectiveAt` is stamped by `publish`, so it is not accepted here.',
    }),
  );
  registry.register(
    'PublishPageVersionRequest',
    PublishPageVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/pages/:pageId/versions/:versionId/publish` (TS-284). Flips a version live: stamps `effectiveAt` (omitted = effective now; supplied = future / backdated for compliance scheduling), repoints the page `currentVersionId`, and moves the page to `published`. The body may be empty (`{}`).',
    }),
  );
  registry.register(
    'ListPagesQuery',
    ListPagesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/content/pages`. Filter by `status`. Bounded by `limit` (default 50, max 200); no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'PageResponse',
    PageResponseSchema.openapi({
      description: 'Single-page envelope (`{ page }`) returned by the create / publish endpoints.',
    }),
  );
  registry.register(
    'PageDetailResponse',
    PageDetailResponseSchema.openapi({
      description:
        'Page-detail envelope (`{ page }` with its nested version history) returned by `GET /api/v1/admin/content/pages/:pageId`.',
    }),
  );
  registry.register(
    'PagesListResponse',
    PagesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/content/pages` — the matching pages ordered by `createdAt` descending.',
    }),
  );
  registry.register(
    'PageVersionResponse',
    PageVersionResponseSchema.openapi({
      description:
        'Single-version envelope (`{ version }`) returned by the append-version endpoint and the single-version GET (the compliance-reachable read).',
    }),
  );

  // Blog / help-article CMS admin surface (TS-284-followup-3; PRD §10.10,
  // §10.11; PDD §19). Mirrors the page aggregate; adds the optional `categoryId`
  // (a `help_categories` node) + a metadata PATCH. Authoring `content:edit`,
  // publish `content:publish`, reads `content:read`. Platform-wide inventory.
  registry.register(
    'ArticleVersionRecord',
    ArticleVersionRecordSchema.openapi({
      description:
        'An append-only saved revision of a blog / help article (TS-284-followup-3). Carries the per-version title + rendered body, the assigned monotonic `versionNo`, the authoring staff `createdBy`, and `effectiveAt` (null until published; a published-then-superseded version keeps its historical `effectiveAt`). Never updated in place.',
    }),
  );
  registry.register(
    'ArticleRecord',
    ArticleRecordSchema.openapi({
      description:
        'Blog / help article record (TS-284-followup-3) — the live editorial entity. Carries the unique slug, lifecycle status, editorial title, the optional `categoryId` (its `help_categories` node; null = uncategorised), and the `currentVersionId` soft pointer to the live version row (null for an article with no version / never published). Shallow — use the article-detail endpoint for the version history.',
    }),
  );
  registry.register(
    'ArticleDetail',
    ArticleDetailSchema.openapi({
      description:
        'Article record WITH its version history (newest-first), returned by `GET /api/v1/admin/content/articles/:articleId` — the article-editor hydration.',
    }),
  );
  registry.register(
    'CreateArticleRequest',
    CreateArticleRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/articles` (TS-284-followup-3). Creates an article shell in `draft` with no version. `slug` must be lowercase kebab-case and unique across articles (a collision is a 409). Optional `categoryId` must resolve to an existing help category (a miss is a 404).',
    }),
  );
  registry.register(
    'UpdateArticleRequest',
    UpdateArticleRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/content/articles/:articleId` (TS-284-followup-3). Updates editorial metadata — `title` and/or `categoryId` (`null` clears the category). At least one field required. Does not touch versions or the publication lifecycle.',
    }),
  );
  registry.register(
    'CreateArticleVersionRequest',
    CreateArticleVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/articles/:articleId/versions` (TS-284-followup-3). Appends a new revision; `versionNo` is assigned server-side (monotonic per article). The version is NOT live on creation — `effectiveAt` is stamped by `publish`.',
    }),
  );
  registry.register(
    'PublishArticleVersionRequest',
    PublishArticleVersionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/articles/:articleId/versions/:versionId/publish` (TS-284-followup-3). Flips a version live: stamps `effectiveAt` (omitted = effective now; supplied = future / backdated), repoints the article `currentVersionId`, and moves the article to `published`. The body may be empty (`{}`).',
    }),
  );
  registry.register(
    'ListArticlesQuery',
    ListArticlesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/content/articles`. Filter by `status` and/or `categoryId`. Bounded by `limit` (default 50, max 200); no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'SendArticleNewsletterRequest',
    SendArticleNewsletterRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/articles/:articleId/newsletter` (TS-288). Triggers a per-post newsletter send. Empty body (`{}`); only a published, not-yet-sent article can be sent (409 otherwise). Emits `content.newsletter.send_requested`; the per-subscriber delivery is the carved service-notification consumer.',
    }),
  );
  registry.register(
    'SendArticleNewsletterResponse',
    SendArticleNewsletterResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/admin/content/articles/:articleId/newsletter` (TS-288) — `{ newsletterSentAt }`, the timestamp the post was marked sent.',
    }),
  );
  registry.register(
    'ArticleResponse',
    ArticleResponseSchema.openapi({
      description:
        'Single-article envelope (`{ article }`) returned by the create / update / publish endpoints.',
    }),
  );
  registry.register(
    'ArticleDetailResponse',
    ArticleDetailResponseSchema.openapi({
      description:
        'Article-detail envelope (`{ article }` with its nested version history) returned by `GET /api/v1/admin/content/articles/:articleId`.',
    }),
  );
  registry.register(
    'ArticlesListResponse',
    ArticlesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/content/articles` — the matching articles ordered by `createdAt` descending.',
    }),
  );
  registry.register(
    'ArticleVersionResponse',
    ArticleVersionResponseSchema.openapi({
      description:
        'Single-version envelope (`{ version }`) returned by the append-version endpoint and the single-version GET.',
    }),
  );
  registry.register(
    'ArticleSeo',
    ArticleSeoSchema.openapi({
      description:
        'Per-article SEO metadata block (TS-282; PDD §19.1) — SEO title, meta description, canonical URL, OpenGraph card (title/description/image), Twitter card (type/title/description/image), and JSON-LD structured data. Every field is nullable (null = not set; the surface falls back to the article title / rendered content). SEO lives on the article (stable identity), not per version. Image fields are media assetKey references.',
    }),
  );
  registry.register(
    'UpdateArticleSeoRequest',
    UpdateArticleSeoRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/content/articles/:articleId/seo` (TS-282). Partial-update SEO metadata — every field optional; a supplied `null` clears that field, an omitted field leaves it unchanged. At least one field required. `canonicalUrl` must be an absolute http(s) URL; `jsonLd` must be a JSON object within the byte cap.',
    }),
  );
  registry.register(
    'ArticleSeoResponse',
    ArticleSeoResponseSchema.openapi({
      description: 'SEO envelope (`{ seo }`) returned by the SEO PATCH endpoint.',
    }),
  );
  registry.register(
    'ArticleComments',
    ArticleCommentsSchema.openapi({
      description:
        'Per-post comments configuration (TS-289; PDD §19.1) — `enabled` per-post toggle, `provider` (`disqus` default / `none`), and `disqusIdentifier` (the per-thread Disqus identifier; null = the public embed falls back to the article slug/id). Read on the article-detail hydration; the actual embed + moderation are carved.',
    }),
  );
  registry.register(
    'PublicBlogArticleListItem',
    PublicBlogArticleListItemSchema.openapi({
      description:
        'PUBLIC blog index card (TS-282-followup-3) — slug, title, publishedAt (the head version’s effectiveAt), nullable metaDescription (the card excerpt), nullable category chip, and the primary byline author. A strict subset of the admin article record: no ids, status, versions, or provenance.',
    }),
  );
  registry.register(
    'PublicBlogArticle',
    PublicBlogArticleSchema.openapi({
      description:
        'PUBLIC published article (TS-282-followup-3) served on `GET /api/v1/content/blog/articles/:slug` — the LIVE version’s canonical Markdown body (rendered only through the ADR-0004 sanitized pipeline), the SEO block (the `generateMetadata` source, TS-282-followup-1), the ordered byline (TS-281-followup-5), and the comments config when the post has comments enabled (TS-289 seam). Drafts/archived articles never serialize to this shape — they are uniform 404s.',
    }),
  );
  registry.register(
    'ListPublicBlogArticlesQuery',
    ListPublicBlogArticlesQuerySchema.openapi({
      description:
        'Query for `GET /api/v1/content/blog/articles` — 1-based `page` (bounded) + optional `category` slug filter. Page size is the fixed server-side constant, not a client knob.',
    }),
  );
  registry.register(
    'PublicBlogArticlesListResponse',
    PublicBlogArticlesListResponseSchema.openapi({
      description:
        'PUBLIC `/blog` index payload — one page of published articles (newest publishedAt first), paging facts for link-based pagination, and the distinct categories in use (the filter bar).',
    }),
  );
  registry.register(
    'PublicBlogArticleResponse',
    PublicBlogArticleResponseSchema.openapi({
      description:
        'Single public-article envelope (`{ article }`) for `GET /api/v1/content/blog/articles/:slug`.',
    }),
  );
  registry.register(
    'UpdateArticleCommentsRequest',
    UpdateArticleCommentsRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/content/articles/:articleId/comments` (TS-289). Partial-update the comments config — every field optional; a supplied `disqusIdentifier: null` clears it, an omitted field leaves it unchanged. At least one field required.',
    }),
  );
  registry.register(
    'ArticleCommentsResponse',
    ArticleCommentsResponseSchema.openapi({
      description:
        'Comments-config envelope (`{ comments }`) returned by the comments PATCH endpoint.',
    }),
  );

  // Help-center taxonomy (category tree) CMS admin surface (TS-284-followup-3;
  // PRD §10.11; PDD §19.3). Self-nesting `parentId` + `sortOrder`; create +
  // PATCH (no version history, no publish lifecycle). Authoring `content:edit`,
  // reads `content:read`. Platform-wide inventory.
  registry.register(
    'HelpCategoryRecord',
    HelpCategoryRecordSchema.openapi({
      description:
        'A help-center category node (TS-284-followup-3). Carries the unique slug, display name, the self-referential `parentId` (null = a root category), and the manual `sortOrder` within its parent. Organises help articles into a tree.',
    }),
  );
  registry.register(
    'CreateHelpCategoryRequest',
    CreateHelpCategoryRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/help-categories` (TS-284-followup-3). `slug` must be lowercase kebab-case and unique (a collision is a 409). Optional `parentId` must resolve to an existing category (a miss is a 404); omitted = a root. `sortOrder` defaults to 0.',
    }),
  );
  registry.register(
    'UpdateHelpCategoryRequest',
    UpdateHelpCategoryRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/content/help-categories/:id` (TS-284-followup-3). Updates `name`, `sortOrder`, and/or `parentId` (`null` promotes to a root). At least one field required. Re-parenting that would create a cycle (self-parent or a descendant parent) is a 409. `slug` is immutable.',
    }),
  );
  registry.register(
    'ListHelpCategoriesQuery',
    ListHelpCategoriesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/content/help-categories`. Optionally narrow to the direct children of a `parentId`. Bounded by `limit` (default 500, max 2000).',
    }),
  );
  registry.register(
    'HelpCategoryResponse',
    HelpCategoryResponseSchema.openapi({
      description:
        'Single-category envelope (`{ category }`) returned by the create / update / detail endpoints.',
    }),
  );
  registry.register(
    'HelpCategoriesListResponse',
    HelpCategoriesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/content/help-categories` — a FLAT array ordered by `(parentId NULLS FIRST, sortOrder, name)`; the client assembles the tree from each node’s `parentId`.',
    }),
  );

  // Author profiles + multi-author collaboration CMS admin surface (TS-283; PRD
  // §10.10; PDD §19.1). Content-staff author profiles (bio / photo / social) +
  // the ordered article byline (co-authorship). Authoring `content:edit`, reads
  // `content:read`. Platform-wide inventory.
  registry.register(
    'ContentAuthorRecord',
    ContentAuthorRecordSchema.openapi({
      description:
        'A content author profile (TS-283). Public authoring identity — display name, bio, photo assetKey, social links — keyed by a UNIQUE soft `userId` (service-identity ref) so the byline persists independently of account/role churn.',
    }),
  );
  registry.register(
    'CreateContentAuthorRequest',
    CreateContentAuthorRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/content/authors` (TS-283). `userId` must be unique across authors (a second profile for the same identity is a 409). `displayName` required; `bio` / `photoAssetKey` / `socialLinks` optional. Social links are http/https-validated.',
    }),
  );
  registry.register(
    'UpdateContentAuthorRequest',
    UpdateContentAuthorRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/content/authors/:authorId` (TS-283). Updates `displayName` / `bio` / `photoAssetKey` / `socialLinks`; a supplied `null` clears the field, an omitted field is unchanged. At least one field required. `userId` is immutable.',
    }),
  );
  registry.register(
    'ListContentAuthorsQuery',
    ListContentAuthorsQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/content/authors`. Bounded by `limit` (default 50, max 200). Ordered by `displayName`.',
    }),
  );
  registry.register(
    'ContentAuthorResponse',
    ContentAuthorResponseSchema.openapi({
      description:
        'Single-author envelope (`{ author }`) returned by the create / update / detail endpoints.',
    }),
  );
  registry.register(
    'ContentAuthorsListResponse',
    ContentAuthorsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/content/authors` — the author profiles ordered by display name.',
    }),
  );
  registry.register(
    'ArticleAuthor',
    ArticleAuthorSchema.openapi({
      description:
        'One credited author on an article byline (TS-283) — the full author record plus its `role` (`primary` | `co_author`) and `sortOrder`.',
    }),
  );
  registry.register(
    'SetArticleAuthorsRequest',
    SetArticleAuthorsRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/admin/content/articles/:articleId/authors` (TS-283) — REPLACE the article’s complete ordered author set. `sortOrder` is assigned from array position; an empty array clears the byline. `authorId`s must be distinct (a duplicate is a 400) and each must resolve to an existing author (a miss is a 404). Bounded to 20.',
    }),
  );
  registry.register(
    'ArticleAuthorsResponse',
    ArticleAuthorsResponseSchema.openapi({
      description:
        'Response body for `GET | PUT /api/v1/admin/content/articles/:articleId/authors` — the article’s ordered byline (each entry = author record + role + sortOrder).',
    }),
  );

  // Article feedback ("Was this helpful?") + related articles (TS-287; PDD
  // §19.3). USER-FACING surfaces — any authenticated reader votes / asks for
  // related articles; NOT admin-permission-gated. One vote per (article, user);
  // aggregate counts computed on read; related = a Phase-2 co-occurrence
  // baseline behind a strategy seam.
  registry.register(
    'SubmitArticleFeedbackRequest',
    SubmitArticleFeedbackRequestSchema.openapi({
      description:
        'Request body for `PUT /api/v1/content/articles/:articleId/feedback` (TS-287) — cast or change the caller’s "Was this helpful?" vote. Idempotent UPSERT keyed by (articleId, userId); a different `rating` flips the vote.',
    }),
  );
  registry.register(
    'ArticleFeedbackSummary',
    ArticleFeedbackSummarySchema.openapi({
      description:
        'Aggregate feedback for an article (helpful / not-helpful counts, computed on read) plus the caller’s own `ownRating` (`null` if the caller has not voted).',
    }),
  );
  registry.register(
    'ArticleFeedbackResponse',
    ArticleFeedbackResponseSchema.openapi({
      description:
        'Envelope (`{ feedback }`) returned by `PUT | GET /api/v1/content/articles/:articleId/feedback`.',
    }),
  );
  registry.register(
    'ListRelatedArticlesQuery',
    ListRelatedArticlesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/content/articles/:articleId/related`. Bounded by `limit` (default 5, max 20).',
    }),
  );
  registry.register(
    'RelatedArticle',
    RelatedArticleSchema.openapi({
      description:
        'A related-article suggestion (TS-287) — a lightweight published-article stub plus a strategy-defined relatedness `score` (higher = more related; not normalised). The Phase-2 baseline sums a category-match weight + shared-author overlap.',
    }),
  );
  registry.register(
    'RelatedArticlesResponse',
    RelatedArticlesResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/content/articles/:articleId/related` — the ranked related articles, most related first.',
    }),
  );

  // Slot-inventory admin surface (TS-272a; PRD §10.9 "Inventory management
  // (slot scheduling)"; PDD §18.1). Read the seeded UI placements + book
  // campaigns into them over a delivery window. Permission-gated on `ads:read`
  // (reads) / `ads:write` (mutations). Platform-wide marketing-admin inventory
  // (no per-household tenant axis). No money field — budget + targeting live on
  // the campaign aggregate (TS-271a); a schedule is the inventory binding only.
  registry.register(
    'AdPlacementRecord',
    AdPlacementRecordSchema.openapi({
      description:
        'Predefined UI slot record (TS-272a) — a seeded placement (home banner, search top-tile, dashboard sidebar, blog footer, partner co-marketing card). `supportedCreativeKinds` constrains which creative kinds may fill the slot. Read-only over the wire: the slot catalog is seeded (`seed:placements`), not authored in the admin UI.',
    }),
  );
  registry.register(
    'AdSlotScheduleRecord',
    AdSlotScheduleRecordSchema.openapi({
      description:
        'Slot-schedule record (TS-272a) — a booking of a campaign into a placement over a delivery window. Carries the placement + campaign ids, lifecycle status, `priority` (orders overlapping schedules on a slot; higher served first), and the window (`startAt` always present, `endAt` null = open-ended). No money field: budget lives on the campaign.',
    }),
  );
  registry.register(
    'CreateAdSlotScheduleRequest',
    CreateAdSlotScheduleRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/ads/slot-schedules` (TS-272a). Books a campaign into a placement. `placementId` + `campaignId` must resolve (a missing one is a 422). `priority` defaults to 0; `status` defaults to `scheduled`. `endAt` is optional (open-ended); when present it must be after `startAt`.',
    }),
  );
  registry.register(
    'UpdateAdSlotScheduleRequest',
    UpdateAdSlotScheduleRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/ads/slot-schedules/:scheduleId` (TS-272a). A partial update; at least one field is required. `endAt` accepts `null` to clear (open-ended). A `status` change must be an allowed transition (a disallowed move is a 409). `placementId` / `campaignId` are not editable — rebinding is a new schedule.',
    }),
  );
  registry.register(
    'ListAdSlotSchedulesQuery',
    ListAdSlotSchedulesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/ads/slot-schedules`. Filter by `placementId` / `campaignId` / `status`. Bounded by `limit` (default 50, max 200); no cursor at Phase-1 volume.',
    }),
  );
  registry.register(
    'AdPlacementsListResponse',
    AdPlacementsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/ads/placements` — the seeded slots ordered by `slotCode`.',
    }),
  );
  registry.register(
    'AdSlotScheduleResponse',
    AdSlotScheduleResponseSchema.openapi({
      description:
        'Single-schedule envelope (`{ schedule }`) returned by the create / detail / update endpoints.',
    }),
  );
  registry.register(
    'AdSlotSchedulesListResponse',
    AdSlotSchedulesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/ads/slot-schedules` — the matching schedules ordered by `createdAt` descending.',
    }),
  );

  // Creative approval-workflow + accessibility-check surface (TS-277; PRD §10.9;
  // PDD §18.3 "Compliance & Approval"). The reviewer works a queue of
  // `pending_review` creatives and approves / rejects / requests-changes; each
  // decision snapshots an accessibility report (alt-text / WCAG contrast /
  // motion / disclosure). The review endpoints are gated on the higher-trust
  // `marketing:approve_creative` (so the author cannot self-approve); the
  // accessibility-metadata edit is the author's `ads:write`.
  registry.register(
    'AdAccessibilityReport',
    AdAccessibilityReportSchema.openapi({
      description:
        'Accessibility evaluation of a creative (TS-277; PDD §18.3) — the four checks (alt-text presence, WCAG contrast ratio, motion safety, mandatory-disclosure acknowledgement) and whether the creative passed (no check failed). Computed live on read; snapshotted onto the review record at decision time.',
    }),
  );
  registry.register(
    'AdCreativeReviewItem',
    AdCreativeReviewItemSchema.openapi({
      description:
        'A creative under review (TS-277) — the creative record, its declared accessibility metadata, the live accessibility report, and minimal campaign context.',
    }),
  );
  registry.register(
    'AdCreativeReviewRecord',
    AdCreativeReviewRecordSchema.openapi({
      description:
        'An immutable, append-only creative review-decision record (TS-277; CLAUDE.md §3.6) — the decision, the reviewer, optional notes, the snapshotted accessibility report, and whether the reviewer overrode a failing report.',
    }),
  );
  registry.register(
    'UpdateAdCreativeAccessibilityRequest',
    UpdateAdCreativeAccessibilityRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/ads/creatives/:creativeId/accessibility` (TS-277). Sets the creative’s accessibility metadata (alt text, text / background hex colours, motion-safe flag, disclosure acknowledgement) before review. Gated on `ads:write`. At least one field required; nullable fields accept `null` to clear.',
    }),
  );
  registry.register(
    'ReviewAdCreativeRequest',
    ReviewAdCreativeRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/ads/creatives/:creativeId/review` (TS-277). Gated on `marketing:approve_creative`. `action` is approve / reject / request_changes; `notes` is required for reject + request_changes; `acknowledgeAccessibilityFailures` (plus notes) is required to approve a creative whose accessibility report fails (an audited override).',
    }),
  );
  registry.register(
    'ListCreativeReviewQueueQuery',
    ListCreativeReviewQueueQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/ads/creatives/review-queue` (TS-277). Returns `pending_review` creatives oldest-first (FIFO). Bounded by `limit` (default 50, max 200).',
    }),
  );
  registry.register(
    'CreativeReviewQueueResponse',
    CreativeReviewQueueResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/ads/creatives/review-queue` (TS-277) — the queued creatives with their live accessibility reports.',
    }),
  );
  registry.register(
    'CreativeReviewDetailResponse',
    CreativeReviewDetailResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/ads/creatives/:creativeId/review` (TS-277) — the creative under review plus its decision history (most recent first).',
    }),
  );
  registry.register(
    'CreativeReviewMutationResponse',
    CreativeReviewMutationResponseSchema.openapi({
      description:
        'Response body for the accessibility PATCH + the review POST (TS-277) — the creative after the mutation with its recomputed accessibility report, and the appended review record (null for the accessibility PATCH).',
    }),
  );

  // Cooking Academy course-catalog admin surface (TS-251; PRD §9.1, §9.5; PDD
  // §15.1). The first authenticated surface on service-academy: create / edit /
  // archive courses, manage the module → lesson hierarchy, and manage a
  // course's cohorts. Permission-gated on `academy:read` (reads) /
  // `academy:write` (mutations). All four resources are platform-wide catalog
  // content (no tenant axis) — the same library every student renders.
  registry.register(
    'AcademyCourseRecord',
    AcademyCourseRecordSchema.openapi({
      description:
        'Cooking Academy course record (TS-251) — the top of the catalog hierarchy (course → module → lesson). Carries the catalog metadata (slug, title, summary, kind, specialty track, difficulty level), the `media-svc` hero-image key, the `passingScorePercent` certification gate, the publication `status` (draft / published / archived), and the `deletedAt` soft-delete tombstone. Shallow — no nested modules; use the course-detail endpoint for the full tree.',
    }),
  );
  registry.register(
    'AcademyCourseDetail',
    AcademyCourseDetailSchema.openapi({
      description:
        'Course record WITH its full catalog tree — ordered modules, each with their ordered lessons. Returned by `GET /api/v1/admin/academy/courses/:courseId` (the catalog editor hydration read).',
    }),
  );
  registry.register(
    'CreateAcademyCourseRequest',
    CreateAcademyCourseRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/courses` (TS-251). Creates a course; `slug` is unique across the catalog (a collision is a 409). `status` defaults to `draft` (a course may be created directly `published`); `track` defaults to `general`.',
    }),
  );
  registry.register(
    'UpdateAcademyCourseRequest',
    UpdateAcademyCourseRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/courses/:courseId` (TS-251). A partial update; at least one field is required. Nullable fields accept `null` to clear. A `status` change must be an allowed transition (draft / published / archived are mutually reachable); a `slug` collision is a 409.',
    }),
  );
  registry.register(
    'ListAcademyCoursesQuery',
    ListAcademyCoursesQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/academy/courses`. Filter by `status` / `track` / `kind`; `includeDeleted=true` widens to soft-deleted courses. Bounded by `limit` (default 50, max 200); no cursor at Phase-1 catalog volume.',
    }),
  );
  registry.register(
    'AcademyCourseResponse',
    AcademyCourseResponseSchema.openapi({
      description:
        'Single-course envelope (`{ course }`) returned by the create / update / delete endpoints.',
    }),
  );
  registry.register(
    'AcademyCourseDetailResponse',
    AcademyCourseDetailResponseSchema.openapi({
      description:
        'Course-detail envelope (`{ course }` with the nested module → lesson tree) returned by `GET /api/v1/admin/academy/courses/:courseId`.',
    }),
  );
  registry.register(
    'AcademyCoursesListResponse',
    AcademyCoursesListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/academy/courses` — the matching courses ordered by `createdAt` descending.',
    }),
  );

  registry.register(
    'AcademyCourseModuleRecord',
    AcademyCourseModuleRecordSchema.openapi({
      description:
        'Cooking Academy course-module record (TS-251) — the middle of the catalog hierarchy. A named, ordered grouping of lessons within a course. Shallow (no nested lessons).',
    }),
  );
  registry.register(
    'AcademyCourseModuleWithLessons',
    AcademyCourseModuleWithLessonsSchema.openapi({
      description:
        'Module record with its ordered lessons — the shape nested inside the course-detail tree.',
    }),
  );
  registry.register(
    'CreateAcademyModuleRequest',
    CreateAcademyModuleRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/courses/:courseId/modules` (TS-251). Appends a module; `sortPosition` is optional (omitted appends after the last module).',
    }),
  );
  registry.register(
    'UpdateAcademyModuleRequest',
    UpdateAcademyModuleRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/modules/:moduleId` (TS-251). A partial update; at least one field is required. `description` accepts `null` to clear.',
    }),
  );
  registry.register(
    'AcademyModuleResponse',
    AcademyModuleResponseSchema.openapi({
      description: 'Single-module envelope (`{ module }`) returned by create / update.',
    }),
  );
  registry.register(
    'AcademyModulesListResponse',
    AcademyModulesListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/admin/academy/courses/:courseId/modules` — the course's modules ordered by `sortPosition` ascending (shallow).",
    }),
  );
  registry.register(
    'DeleteAcademyModuleResponse',
    DeleteAcademyModuleResponseSchema.openapi({
      description:
        'Response body for `DELETE /api/v1/admin/academy/modules/:moduleId` — confirms removal and reports how many lessons cascaded with it.',
    }),
  );

  registry.register(
    'AcademyLessonRecord',
    AcademyLessonRecordSchema.openapi({
      description:
        'Cooking Academy lesson record (TS-251) — the leaf of the catalog hierarchy. `kind` (video / reading / quiz / assignment) picks the lesson-player renderer; `contentKey` references a `media-svc` S3 asset for video lessons; `bodyMarkdown` holds inline reading content.',
    }),
  );
  registry.register(
    'CreateAcademyLessonRequest',
    CreateAcademyLessonRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/modules/:moduleId/lessons` (TS-251). Appends a lesson; `sortPosition` is optional. Content fields are optional (authored incrementally).',
    }),
  );
  registry.register(
    'UpdateAcademyLessonRequest',
    UpdateAcademyLessonRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/lessons/:lessonId` (TS-251). A partial update; at least one field is required. Nullable content fields accept `null` to clear.',
    }),
  );
  registry.register(
    'AcademyLessonResponse',
    AcademyLessonResponseSchema.openapi({
      description: 'Single-lesson envelope (`{ lesson }`) returned by create / update.',
    }),
  );
  registry.register(
    'AcademyLessonsListResponse',
    AcademyLessonsListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/admin/academy/modules/:moduleId/lessons` — the module's lessons ordered by `sortPosition` ascending.",
    }),
  );

  registry.register(
    'AcademyCohortRecord',
    AcademyCohortRecordSchema.openapi({
      description:
        'Cooking Academy cohort record (TS-251) — a scheduled run of a cohort-based course with a start / end window, optional capacity + instructor, and a lifecycle status (scheduled → open → in_progress → completed; canceled). Carries a `deletedAt` soft-delete tombstone.',
    }),
  );
  registry.register(
    'CreateAcademyCohortRequest',
    CreateAcademyCohortRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/courses/:courseId/cohorts` (TS-251). Schedules a cohort; `status` defaults to `scheduled` (may be created `open`). When `endsAt` is supplied it must be after `startsAt`.',
    }),
  );
  registry.register(
    'UpdateAcademyCohortRequest',
    UpdateAcademyCohortRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/cohorts/:cohortId` (TS-251). A partial update; at least one field is required. Nullable fields accept `null` to clear. A `status` change must be an allowed transition; a terminal (completed / canceled) cohort rejects all edits.',
    }),
  );
  registry.register(
    'ListAcademyCohortsQuery',
    ListAcademyCohortsQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/academy/courses/:courseId/cohorts`. Filter by `status`; `includeDeleted=true` widens to soft-deleted cohorts. Bounded by `limit` (default 50, max 200).',
    }),
  );
  registry.register(
    'AcademyCohortResponse',
    AcademyCohortResponseSchema.openapi({
      description: 'Single-cohort envelope (`{ cohort }`) returned by create / update / delete.',
    }),
  );
  registry.register(
    'AcademyCohortsListResponse',
    AcademyCohortsListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/admin/academy/courses/:courseId/cohorts` — the course's cohorts ordered by `startsAt` ascending.",
    }),
  );

  // Cooking Academy quiz engine (TS-254; PRD §9.2–§9.3; PDD §15.1). Two
  // surfaces: the ADMIN authoring DTOs (the versioned question bank, options
  // carrying `isCorrect`) gated on `academy:read` / `academy:write`, and the
  // STUDENT attempt DTOs (presented questions WITHOUT `isCorrect`; graded
  // answers reveal the key only after submit) behind `AccessTokenGuard`.
  registry.register(
    'AcademyQuizRecord',
    AcademyQuizRecordSchema.openapi({
      description:
        'Cooking Academy quiz config record (TS-254) — the engine settings for a `quiz`-kind lesson: the N-of-M draw (`questionsPerAttempt`), the certification gate (`passingScorePercent`), the retake policy (`maxAttempts` / `retakeCooldownMinutes`), and the monotonic `bankVersion`. `questionCount` is the live count of active bank questions. Shallow — no nested questions; use the authoring-tree read for the bank.',
    }),
  );
  registry.register(
    'AcademyQuizQuestionOptionRecord',
    AcademyQuizQuestionOptionRecordSchema.openapi({
      description:
        'A quiz answer option as the AUTHOR sees it (TS-254) — carries the `isCorrect` answer-key flag. NEVER returned on the student attempt surface (see `PresentedQuizQuestion`).',
    }),
  );
  registry.register(
    'AcademyQuizQuestionRecord',
    AcademyQuizQuestionRecordSchema.openapi({
      description:
        'A quiz question as the AUTHOR sees it (TS-254) — prompt, `kind` (single_choice / multiple_choice / true_false), score `points`, and its full option set WITH correctness flags.',
    }),
  );
  registry.register(
    'AcademyQuizAuthoringTree',
    AcademyQuizAuthoringTreeSchema.openapi({
      description:
        'A quiz config WITH its full active question bank — the authoring-tree hydration read returned by `GET /api/v1/admin/academy/lessons/:lessonId/quiz`.',
    }),
  );
  registry.register(
    'CreateAcademyQuizRequest',
    CreateAcademyQuizRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/lessons/:lessonId/quiz` (TS-254). Attaches a quiz to a `quiz`-kind lesson (one per lesson — a second is a 409). The bank is built separately via the question endpoints; a quiz cannot be started until it holds ≥ `questionsPerAttempt` active questions.',
    }),
  );
  registry.register(
    'UpdateAcademyQuizRequest',
    UpdateAcademyQuizRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/quizzes/:quizId` (TS-254). A partial config update; at least one field. Nullable policy fields (`maxAttempts`, `retakeCooldownMinutes`, `instructions`) accept `null` to clear.',
    }),
  );
  registry.register(
    'CreateAcademyQuizQuestionRequest',
    CreateAcademyQuizQuestionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/quizzes/:quizId/questions` (TS-254). Appends a question with its options inline. The per-kind correctness rule is enforced: exactly one correct for single_choice / true_false (true_false additionally requires exactly two options); ≥ 1 correct for multiple_choice. Mutating the bank bumps `bankVersion`.',
    }),
  );
  registry.register(
    'UpdateAcademyQuizQuestionRequest',
    UpdateAcademyQuizQuestionRequestSchema.openapi({
      description:
        'Request body for `PATCH /api/v1/admin/academy/questions/:questionId` (TS-254). A partial update; at least one field. Supplying `options` REPLACES the full option set; when `kind` accompanies it the per-kind correctness rule is enforced. Mutating the bank bumps `bankVersion`.',
    }),
  );
  registry.register(
    'AcademyQuizResponse',
    AcademyQuizResponseSchema.openapi({
      description: 'Single-quiz config envelope (`{ quiz }`) returned by create / update.',
    }),
  );
  registry.register(
    'AcademyQuizAuthoringResponse',
    AcademyQuizAuthoringResponseSchema.openapi({
      description:
        'Authoring-tree envelope (`{ quiz }` with the nested active question bank) returned by `GET /api/v1/admin/academy/lessons/:lessonId/quiz`.',
    }),
  );
  registry.register(
    'AcademyQuizQuestionResponse',
    AcademyQuizQuestionResponseSchema.openapi({
      description:
        'Single-question envelope (`{ question }`) returned by question create / update.',
    }),
  );
  registry.register(
    'PresentedQuizQuestion',
    PresentedQuizQuestionSchema.openapi({
      description:
        'A quiz question as PRESENTED to a student during an attempt (TS-254) — prompt, kind, points, and options in presentation order WITHOUT any `isCorrect` data. The answer key is never on this shape.',
    }),
  );
  registry.register(
    'AcademyQuizAttemptRecord',
    AcademyQuizAttemptRecordSchema.openapi({
      description:
        "A student's quiz attempt (TS-254). Freezes the drawn `questionIds` + `bankVersion` at start; the scoring columns (`pointsAwarded` / `pointsPossible` / `scorePercent` / `passed` / `submittedAt`) are null until the attempt is `submitted`.",
    }),
  );
  registry.register(
    'GradedQuizAnswer',
    GradedQuizAnswerSchema.openapi({
      description:
        "A graded answer revealed after submit (TS-254) — the student's `selectedOptionIds`, the now-safe-to-show `correctOptionIds`, the boolean `correct` outcome, and points awarded vs. possible.",
    }),
  );
  registry.register(
    'AcademyQuizAttemptDetail',
    AcademyQuizAttemptDetailSchema.openapi({
      description:
        'Full attempt detail returned by start / submit / get (TS-254). At start, `questions` carries the drawn presented set and `answers` is empty; after submit, `answers` carries the graded results.',
    }),
  );
  registry.register(
    'SubmitQuizAttemptRequest',
    SubmitQuizAttemptRequestSchema.openapi({
      description:
        "Request body for `POST /api/v1/academy/attempts/:attemptId/submit` (TS-254). One answer per answered question (an unanswered drawn question scores zero); a question id outside the attempt's drawn set, or a duplicate, is a 422.",
    }),
  );
  registry.register(
    'AcademyQuizAttemptDetailResponse',
    AcademyQuizAttemptDetailResponseSchema.openapi({
      description:
        'Attempt-detail envelope (`{ detail }`) returned by `POST .../attempts` (start), `POST .../attempts/:id/submit`, and `GET .../attempts/:id`.',
    }),
  );
  registry.register(
    'AcademyQuizAttemptsListResponse',
    AcademyQuizAttemptsListResponseSchema.openapi({
      description:
        "Response body for `GET /api/v1/academy/quizzes/:quizId/attempts` — the student's own attempts at the quiz, newest first (drives the retake-policy display).",
    }),
  );

  // Cooking Academy certification issuance + verification (TS-255; PRD §9.3;
  // PDD §15.2). Two audiences split across the schemas: the ADMIN surface
  // (`academy:read` / `academy:write`) issues / lists / revokes the full
  // record, and the PUBLIC `/verify/cert/{token}` surface returns a strict,
  // PII-minimised subset (holder + course + track + dates + status + a derived
  // `valid` flag — never the studentUserId, PDF key, or internal ids). The
  // public-shape-is-a-subset property is the load-bearing security guarantee.
  registry.register(
    'IssueAcademyCertificationRequest',
    IssueAcademyCertificationRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/certifications` — issue a certification. Names the `studentUserId` + `courseId` + `holderName` (snapshotted onto the certificate); the service captures the course `title` + `track`, mints the verification token, renders the PDF, and stamps the renewal expiry. Optional `enrollmentId` is verified `completed` + owned by the student+course when present. `expiresInMonths` defaults to 24 (PDD §15.2). Honour `Idempotency-Key`.',
    }),
  );
  registry.register(
    'RevokeAcademyCertificationRequest',
    RevokeAcademyCertificationRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/academy/certifications/:certificationId/revocation` — revoke a certification (status → `revoked`, stamps `revokedAt`). Append-only: a certification is never deleted (CLAUDE.md §3.6). Optional free-text audit memo.',
    }),
  );
  registry.register(
    'ListAcademyCertificationsQuery',
    ListAcademyCertificationsQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/academy/certifications` — optional `studentUserId` / `courseId` / `status` filters + cursorless `limit` (default 50, max 200). An empty query lists the newest certifications across the catalog.',
    }),
  );
  registry.register(
    'AcademyCertificationRecord',
    AcademyCertificationRecordSchema.openapi({
      description:
        'Full certification record (TS-255) — admin-only. Carries the snapshotted `title` / `track` / `holderName`, the lifecycle `status` (active / expired / revoked), the unique `verificationToken`, the `media-svc` `certificatePdfKey`, the renewal `expiresAt`, and the internal ids (`studentUserId`, `enrollmentId`). The public verification view is a strict subset of this shape.',
    }),
  );
  registry.register(
    'AcademyCertificationResponse',
    AcademyCertificationResponseSchema.openapi({
      description: 'Single-record envelope (`{ certification }`) returned by issue / get / revoke.',
    }),
  );
  registry.register(
    'AcademyCertificationsListResponse',
    AcademyCertificationsListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/academy/certifications` — the matching certifications, newest issued first.',
    }),
  );
  registry.register(
    'PublicCertificationVerification',
    PublicCertificationVerificationSchema.openapi({
      description:
        'PUBLIC verification view returned by `GET /verify/cert/:token` (no auth). A strict, PII-minimised subset of the record — holder name, course title + track, status, a derived `valid` flag (active AND not past `expiresAt`), and the issue / expiry dates. NEVER carries the `studentUserId`, `certificatePdfKey`, `enrollmentId`, or certification `id` (PRD §9.3 diploma-style credential check).',
    }),
  );
  registry.register(
    'PublicCertificationVerificationResponse',
    PublicCertificationVerificationResponseSchema.openapi({
      description:
        'Envelope (`{ verification }`) for the public `GET /verify/cert/:token` response.',
    }),
  );

  // TS-256 — certification-renewal worker internal surfaces (PRD §9.3; PDD
  // §15.2). Shared-secret-pinned, in-cluster only; registered here so the
  // OpenAPI artifact carries the worker's read + expire shapes for drift
  // detection + partner-doc completeness (same posture as the TS-235
  // wellness-summary internal surfaces).
  registry.register(
    'CertificationRenewalCandidate',
    CertificationRenewalCandidateSchema.openapi({
      description:
        'One certification at or approaching its renewal expiry (TS-256; internal, worker-only). Carries the holder’s `studentUserId` + the snapshotted `holderName` (nullable), the snapshotted `courseTitle` + `track`, and the non-null `expiresAt` the worker derives the reminder milestone (or lapsed state) from. Omits the verification token + PDF key + enrollment id (not needed by the worker).',
    }),
  );
  registry.register(
    'InternalCertificationRenewalsResponse',
    InternalCertificationRenewalsResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/internal/academy/certifications/renewals` (TS-256; shared-secret-pinned, in-cluster). Cursor-paginated batch of active certifications whose `expiresAt` is already past OR within `horizonDays`. `nextCursor` is the last certification id when a further page may exist, else null.',
    }),
  );
  registry.register(
    'InternalCertificationRenewalsQuery',
    InternalCertificationRenewalsQuerySchema.openapi({
      description:
        'Query string for `GET /api/v1/internal/academy/certifications/renewals` (TS-256). Keyset cursor pagination ordered by certification id, with a `horizonDays` cap on the forward scan window (default = the 90-day max reminder milestone).',
    }),
  );
  registry.register(
    'ExpireCertificationResponse',
    ExpireCertificationResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/internal/academy/certifications/:certificationId/expire` (TS-256; shared-secret-pinned). The idempotent lapse write: an `active` certification past its expiry flips to `expired` (`changed: true`); an already-`expired` or terminal `revoked` certification is a no-op (`changed: false`). 404 when the certification does not exist.',
    }),
  );

  // TS-101-followup-9 — service-activity surface schemas land alongside the
  // already-published HTTP DTOs so consumers reading the OpenAPI artifact
  // (admin tooling type-generation via TS-126; the BFF stub generation) see
  // the activity ingest + read surfaces. The activity stream (PDD §17.2 user
  // activity log, §17.3 site-wide monitoring) is intentionally simpler than
  // the audit-svc surface — no hash chain, no before/after diff. Three
  // endpoint clusters: internal ingest (`POST /api/v1/internal/activity/
  // events`, shared-secret-pinned, idempotent on `eventId`), the user-facing
  // self-view (`GET /api/v1/users/me/activity`), and the admin search
  // (`GET /api/v1/admin/users/:userId/activity`, future `activity:read`
  // gating per TS-101-followup-7). Seven schemas span the categorical kind
  // enum (`ActivityEventKind`), the ingest request (`RecordActivityEventRequest`),
  // the canonical row response (`ActivityEventResponse`), the ingest envelope
  // (`RecordActivityEventResponse`), the two list query shapes
  // (`ListMyActivityQuery` + `ListUserActivityQuery`), and the cursor-paginated
  // list response (`ActivityEventsListResponse`).
  registry.register(
    'ActivityEventKind',
    ActivityEventKindSchema.openapi({
      description:
        'Categorical kind of activity event (TS-101; PDD §17.2). Phase-1 kinds span authentication & session (`login_success` / `login_failure` / `logout` / `password_changed` / `mfa_enrolled` / `mfa_removed`), profile & payments (`profile_changed` / `payment_method_added` / `payment_method_removed`), subscription & booking (`subscription_changed` / `booking_created` / `booking_canceled`), admin-staff role lifecycle (`role_granted` / `role_revoked`), and trust & safety (`suspicious_activity_flag`). Future kinds land additively — never repurpose an existing value (CLAUDE.md §5.3).',
    }),
  );
  registry.register(
    'RecordActivityEventRequest',
    RecordActivityEventRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/internal/activity/events` (TS-101). Cross-service producers stamp every notable user-visible event with a producer-assigned `eventId` and POST the envelope; the activity service is idempotent on `eventId` (a retried submission replays into the existing row). `userId` is required — the stream is per-user. Request metadata (`ip` / `userAgent` / `deviceFingerprint` / `requestId` / `traceId`) and a small `metadata` adjunct (≤8 KiB stringified) are optional. The endpoint is shared-secret-pinned (in-cluster callers only). `.strict()` — unknown fields are a parse error.',
    }),
  );
  registry.register(
    'ActivityEventResponse',
    ActivityEventResponseSchema.openapi({
      description:
        'Activity event row projected from the persisted record (TS-101). Returned by every read endpoint (self-view + admin view). `id` is the row id; `eventId` is the producer-assigned idempotency key. Request-metadata fields are nullable (a system-driven producer may not carry an IP / user-agent).',
    }),
  );
  registry.register(
    'RecordActivityEventResponse',
    RecordActivityEventResponseSchema.openapi({
      description:
        "Response body for `POST /api/v1/internal/activity/events`. `outcome: 'recorded'` — a new event was persisted; `outcome: 'replayed'` — the `eventId` was already on file and the existing row is returned unchanged (idempotent replay).",
    }),
  );
  registry.register(
    'ListMyActivityQuery',
    ListMyActivityQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/users/me/activity` (TS-101) — the user-facing self-view (PRD §6.1 family observer activity page). The actor `userId` comes from the access token; no `userId` query param is accepted (row-level-access smell). Optional `kind` filter narrows to one category; cursor-paginated (`limit` default 50, max 200).',
    }),
  );
  registry.register(
    'ListUserActivityQuery',
    ListUserActivityQuerySchema.openapi({
      description:
        'Query parameters for `GET /api/v1/admin/users/:userId/activity` (TS-101) — the admin search. The target `userId` lives on the route path; this shape covers only the `kind` filter + cursor pagination. Permission gating (`activity:read`) lands with the `PermissionGuard` lift (TS-101-followup-7 / TS-052-followup-11).',
    }),
  );
  registry.register(
    'ActivityEventsListResponse',
    ActivityEventsListResponseSchema.openapi({
      description:
        'Cursor-paginated list response for the activity read endpoints. `events` are ordered newest-first; `nextCursor` is null when the caller has reached the end of the result set.',
    }),
  );

  // ── Privacy Center (TS-309a / TS-309b1; registered by TS-309b1-followup-1)
  //
  // The data-subject request lifecycle and the export-contribution seam. Two
  // audiences with deliberately different shapes: a REQUESTER sees a
  // `DataSubjectRequestReceipt`, an operator sees a
  // `DataSubjectRequestRecord`, and the difference between them is exactly
  // what may be disclosed — the receipt withholds the verification method,
  // the internal notes and the operator ids. Publishing both in one document
  // is the point: a consumer that confuses them is over-disclosing, and the
  // gateway re-validates against these shapes and 502s on drift.
  registry.register(
    'DataSubjectRequestKind',
    DataSubjectRequestKindSchema.openapi({
      description:
        'What the requester is asking for. `erasure` is accepted even though execution is compliance-blocked (TS-309c): refusing to RECORD a request would be worse than refusing to fulfil one, and a recorded refusal with a categorical reason is most of what a regulator asks to see.',
    }),
  );
  registry.register(
    'DataSubjectKind',
    DataSubjectKindSchema.openapi({
      description:
        'Who the data is about. `senior` is separate from `user` because a senior is often not an account at all — the household directory models seniors as their own records, and they are the subject of most of the platform’s sensitive data while frequently never logging in.',
    }),
  );
  registry.register(
    'DataSubjectRequestStatus',
    DataSubjectRequestStatusSchema.openapi({
      description:
        'Lifecycle state. `verifying` is transient — every request walks `received → verifying → in_progress` so the verification step is exercised rather than declared. `fulfilled`, `refused` and `withdrawn` are terminal.',
    }),
  );
  registry.register(
    'DataSubjectRequestRefusalReason',
    DataSubjectRequestRefusalReasonSchema.openapi({
      description:
        'Why a request was refused — categorical, because a request that quietly stops progressing is indistinguishable from one nobody worked. `retention_required` records the OUTCOME, never a citation: which records must be kept is legal reference data this platform does not author.',
    }),
  );
  registry.register(
    'CreateBillingPortalSessionRequest',
    CreateBillingPortalSessionRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/billing/portal-sessions`. EMPTY, and strict so that emptiness is enforced rather than conventional. A portal session confers full billing control — update the card, read every invoice, cancel the subscription — so the Stripe customer is derived from the caller’s token scope and the `return_url` from server config. A `customerId` or `returnUrl` in the body is a 400, not a silently ignored field.',
    }),
  );
  registry.register(
    'BillingPortalSessionResponse',
    BillingPortalSessionResponseSchema.openapi({
      description:
        'Response body for `POST /api/v1/billing/portal-sessions`. One field: the Stripe-hosted portal URL. Single-use and short-lived — redirect to it immediately; never store, email, log, or render it as a link the user might return to.',
    }),
  );
  registry.register(
    'MySubscriptionSummary',
    MySubscriptionSummarySchema.openapi({
      description:
        'The FAMILY-facing view of one’s own membership. Deliberately narrower than `SubscriptionResponse`: no Stripe ids (handles to another system’s objects), no `dunningAttempts` (a retry count is a collections notice — the dunning copy refuses to state it and so does this), no `pauseReason` (free text possibly written about the household), no scoping key echoed back. `paymentTrouble` is derived server-side so the portal cannot arrive at a gentler answer than the emails did.',
    }),
  );
  registry.register(
    'MySubscriptionResponse',
    MySubscriptionResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/subscriptions/me`. `subscription: null` is a SUCCESS, not a 404 — "you have no membership" is a true answer to "what is my membership", and a household that has never subscribed is not an error.',
    }),
  );
  registry.register(
    'CreateDataSubjectRequest',
    CreateDataSubjectRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/privacy/requests`. `subjectKind` / `subjectId` are optional and their ABSENCE means "me" — the subject is stamped from the verified token. They must be supplied together: a `subjectId` with no kind is an id whose meaning nobody stated, and a kind with no id is a request about an unnamed person. There is no `requesterUserId` field, deliberately — a record in which the caller names themselves is worthless as evidence.',
    }),
  );
  registry.register(
    'DataSubjectRequestReceipt',
    DataSubjectRequestReceiptSchema.openapi({
      description:
        'The REQUESTER-facing view of a request. Deliberately narrower than `DataSubjectRequestRecord`: no verification method (publishing it teaches how to defeat it), no operator ids, no internal notes.',
    }),
  );
  registry.register(
    'DataSubjectRequestReceiptResponse',
    DataSubjectRequestReceiptResponseSchema.openapi({
      description:
        'Response body for the requester routes (`POST /api/v1/privacy/requests`, `GET /api/v1/privacy/requests/{id}`, `POST /api/v1/privacy/requests/{id}/withdraw`). Someone else’s request answers 404, not 403 — confirming that a request exists is itself a disclosure.',
    }),
  );
  registry.register(
    'DataSubjectRequestListResponse',
    DataSubjectRequestListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/privacy/requests` — the requester’s own requests, as receipts.',
    }),
  );
  registry.register(
    'DataSubjectRequestRecord',
    DataSubjectRequestRecordSchema.openapi({
      description:
        'The OPERATOR-facing view (`privacy:read`). Carries the full verification trail, the refusal reason and note, and the extension trail. Never returned to a requester.',
    }),
  );
  registry.register(
    'DataSubjectRequestResponse',
    DataSubjectRequestResponseSchema.openapi({
      description:
        'Response body for the operator routes (`GET /api/v1/admin/privacy/requests/{id}` and the three acts). Wraps a `DataSubjectRequestRecord`.',
    }),
  );
  registry.register(
    'AdminDataSubjectRequestListResponse',
    AdminDataSubjectRequestListResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/privacy/requests` — the operator queue, as records.',
    }),
  );
  registry.register(
    'ListDataSubjectRequestsQuery',
    ListDataSubjectRequestsQuerySchema.openapi({
      description:
        'Query string for the operator queue: optional `status` / `kind` / `subjectKind` filters plus a bounded `limit`.',
    }),
  );
  registry.register(
    'VerifyDataSubjectRequest',
    VerifyDataSubjectRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/privacy/requests/{id}/verify`. The verification is all-or-nothing — a DB CHECK enforces that the timestamp, the verifier and the method are written together, so a half-written verification (which would read as "verified by nobody for no reason") is unrepresentable.',
    }),
  );
  registry.register(
    'RefuseDataSubjectRequest',
    RefuseDataSubjectRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/privacy/requests/{id}/refuse`. The categorical reason is required; the note is for the operator record, not the requester.',
    }),
  );
  registry.register(
    'ExtendDataSubjectRequest',
    ExtendDataSubjectRequestSchema.openapi({
      description:
        'Request body for `POST /api/v1/admin/privacy/requests/{id}/extend` — the single permitted extension, with a required reason. A second attempt is a 409.',
    }),
  );
  registry.register(
    'PrivacyExportSection',
    PrivacyExportSectionSchema.openapi({
      description:
        'A named group of records within one service’s export slice (TS-309b1). `recordCount` is counted INDEPENDENTLY of `records` and the schema cross-checks them, so a service that cannot serve a subject’s rows in one response fails loudly rather than returning a page under a heading that claims to be the whole story.',
    }),
  );
  registry.register(
    'PrivacyExportWithholding',
    PrivacyExportWithholdingSchema.openapi({
      description:
        'A declared omission from an export slice, with a categorical reason (`credential_material`, `identity_evidence`, `security_control`, `third_party_data`). Dropping a column silently would produce an export that READS as complete and is not — the same failure as shipping a partial archive.',
    }),
  );
  registry.register(
    'PrivacyExportSlice',
    PrivacyExportSliceSchema.openapi({
      description:
        'One owning service’s answer to `GET /api/v1/internal/privacy/export/{subjectKind}/{subjectId}` (TS-309b1; shared-secret-pinned, never exposed at the edge). A discriminated union on `outcome`: `held` (data, with every omission declared), `no_records` (this service holds subjects of this kind and found none for this one — an answer about the person), and `not_applicable` (this service never holds this kind of subject at all — a structural fact). The two "nothing" cases are separate on purpose: collapsing them into an empty array loses the distinction the request is about.',
    }),
  );
  registry.register(
    'PrivacyExportSliceParams',
    PrivacyExportSliceParamsSchema.openapi({
      description:
        'Path parameters of the export-contribution route. Validated at the boundary like any other input — the shared secret establishes that the caller is in-cluster, not that the ids it carries are well-formed.',
    }),
  );

  // ── Provider review surfaces (TS-305a / TS-305b / TS-305d) ────────
  //
  // These three were never registered. `generated/openapi.json` has
  // carried no dossier and no 360 since TS-305a, which is why changing
  // the dossier's shape needed no regeneration and why nobody noticed —
  // every other admin read surface on the platform is in here
  // (TS-305d-followup-4).
  //
  // The description blocks carry the DISCLOSURE reasoning rather than a
  // field list, per the TS-309b1-followup-1 precedent. A consumer's real
  // risk on this surface is reading a state as a score.
  registry.register(
    'ProviderDossierCore',
    ProviderDossierCoreSchema.openapi({
      description:
        'The provider row as a review surface sees it (TS-305a). Carries `userId` and `deletedAt`, which the public profile does not: a committee convened about a provider archived last month needs exactly that row, so unlike the public GET this surface SERVES soft-deleted providers rather than 404-ing them.',
    }),
  );
  registry.register(
    'ProviderDossierBackgroundCheck',
    ProviderDossierBackgroundCheckSchema.openapi({
      description:
        'The most recent background check as a VERDICT, five columns wide. The Checkr candidate/report handles and the AES-GCM payload are projected out at the SQL layer, so the consumer report never enters process memory on this path — a leak here would have to be written on purpose. `null` means no check on file, which is itself a finding and must be rendered as one rather than as an empty panel.',
    }),
  );
  registry.register(
    'ProviderMetricsCounts',
    ProviderMetricsCountsSchema.openapi({
      description:
        'The counted facts behind every provider rate (TS-305d), always shipped WITH the rates — a rate without its denominator cannot be argued with, and this surface exists to be argued with. Two namings are load-bearing. `bookingsCanceledAfterAcceptance` is not "cancellations caused": the platform cannot resolve whether a canceller was the provider, the family payer or an admin without a cross-service read §2.3 forbids, so the name states what is known and no more. `bookingsExpiredUnanswered` is kept apart from `bookingsDeclined` (silence and refusal are different behaviours) and `bookingsDeclinedByAdmin` from both (not the provider’s act at all, and excluded from every rate).',
    }),
  );
  registry.register(
    'ProviderMetricsWindow',
    ProviderMetricsWindowSchema.openapi({
      description:
        'One window of provider performance figures (TS-305d). A discriminated union on `state`, and the three cases are NOT interchangeable: `measured` (enough history to state a rate), `insufficient_data` (some history, too little for a percentage to mean anything — it still carries the counts, so a reader may see "two bookings, both completed" but never "100%"), and `no_activity` (no booking has ever been seen). Reading `insufficient_data` or `no_activity` as a bad score is the specific mistake this shape exists to prevent: neither is a zero, and neither implies a problem. Rates are integer tenths of a percent so two surfaces cannot render the same figure differently. `medianResponseSeconds` is a MEDIAN — one offer answered after a fortnight’s holiday would drag a mean far enough to misdescribe every other week.',
    }),
  );
  registry.register(
    'ProviderMetricsSection',
    ProviderMetricsSectionSchema.openapi({
      description:
        'Provider reliability as carried on the dossier and the 360 (TS-305d). BOTH windows are always present because neither is derivable from the other — "is this provider dependable right now" and "over their whole time with us" are different questions and both are legitimate. `windowDays` travels with the figures so no surface hard-codes it into copy. `firstObservedAt` is not decorative: a lifetime rate over three weeks and one over three years wear the same label and nothing else distinguishes them. There is deliberately NO rating field anywhere on this surface — nothing on the platform captures one, and a nullable field would read as "this provider has none" (TS-305e).',
    }),
  );
  registry.register(
    'ProviderDossierResponse',
    ProviderDossierResponseSchema.openapi({
      description:
        'Response body for `GET /api/v1/admin/providers/{providerId}/dossier` (TS-305a), gated `provider:read`. `certifications` is the FULL issuance history rather than the active-only set the provider self-view returns — a revoked credential is the single most relevant row on a review surface. `generatedAt` is composition wall-clock and matters more here than on most reads: a committee screenshots this page into a deliberation record.',
    }),
  );
  registry.register(
    'Provider360IncidentsSection',
    Provider360IncidentsSectionSchema.openapi({
      description:
        'The trust & safety history on the 360 (TS-305b). A discriminated union so that "a clean record" and "we could not ask" cannot blur: an empty array under `state: "available"` is a clean record, `state: "unavailable"` names a reason. A committee may deliberate on credentials while trust-safety is down, but must never see a page that silently omits a complaint history.',
    }),
  );
  registry.register(
    'Provider360Response',
    Provider360ResponseSchema.openapi({
      description:
        'Response body for the gateway aggregator `GET /api/v1/admin/providers/{providerId}/360` (TS-305b), gated on BOTH `provider:read` and `trust_safety:write`. The dossier upstream is FATAL and the incidents upstream DEGRADES — the deliberate contrast with the visit-prep aggregator. `metrics` arrives inside the dossier and is passed through, so it is not a second degradable section: if the dossier answered at all, the metrics answered with it. `generatedAt` is the GATEWAY’s composition clock, not the dossier’s, which predates the fan-out.',
    }),
  );

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description !== undefined && { description: info.description }),
    },
  };

  return generator.generateDocument(document as Parameters<typeof generator.generateDocument>[0]);
}
