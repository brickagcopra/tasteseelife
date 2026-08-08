import { Module } from '@nestjs/common';

import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { AdminAcademyCohortsProxyController } from './admin-academy-cohorts-proxy.controller';
import { AdminAcademyCoursesProxyController } from './admin-academy-courses-proxy.controller';
import { AdminAcademyLessonsProxyController } from './admin-academy-lessons-proxy.controller';
import { AdminAcademyModulesProxyController } from './admin-academy-modules-proxy.controller';
import { AdminAdsCampaignsProxyController } from './admin-ads-campaigns-proxy.controller';
import { AdminAuditEventsProxyController } from './admin-audit-events-proxy.controller';
import { AdminAdsCreativesProxyController } from './admin-ads-creatives-proxy.controller';
import { AdminAdsSlotsProxyController } from './admin-ads-slots-proxy.controller';
import { AdminBookingHoldsProxyController } from './admin-booking-holds-proxy.controller';
import { AdminBookingsProxyController } from './admin-bookings-proxy.controller';
import { AdminChartOfAccountsProxyController } from './admin-chart-of-accounts-proxy.controller';
import { AdminConciergeAssignmentsProxyController } from './admin-concierge-assignments-proxy.controller';
import { AdminConciergeEnrichmentSummariesProxyController } from './admin-concierge-enrichment-summaries-proxy.controller';
import { AdminConciergeOnboardingsProxyController } from './admin-concierge-onboardings-proxy.controller';
import { AdminDeferredRevenueProxyController } from './admin-deferred-revenue-proxy.controller';
import { AdminConciergeOpsProxyController } from './admin-concierge-ops-proxy.controller';
import { AdminConciergeScheduledEventsProxyController } from './admin-concierge-scheduled-events-proxy.controller';
import { AdminConciergeTransportationProxyController } from './admin-concierge-transportation-proxy.controller';
import { AdminContentArticlesProxyController } from './admin-content-articles-proxy.controller';
import { AdminContentAuthorsProxyController } from './admin-content-authors-proxy.controller';
import { AdminContentHelpCategoriesProxyController } from './admin-content-help-categories-proxy.controller';
import { AdminMediaAssetsProxyController } from './admin-media-assets-proxy.controller';
import { MfaProxyController } from './mfa-proxy.controller';
import { ContentFeedbackProxyController } from './content-feedback-proxy.controller';
import { PublicBlogProxyController } from './public-blog-proxy.controller';
import { AdminProvider360AggregatorController } from './admin-provider-360-aggregator.controller';
import { AdminProvidersProxyController } from './admin-providers-proxy.controller';
import { AdminTrustSafetyIncidentsProxyController } from './admin-trust-safety-incidents-proxy.controller';
import {
  AdminPrivacyRequestsProxyController,
  PrivacyRequestsProxyController,
} from './privacy-requests-proxy.controller';
import { AdminTrustSafetyMandatedReporterProxyController } from './admin-trust-safety-mandated-reporter-proxy.controller';
import { TrustSafetyIncidentsProxyController } from './trust-safety-incidents-proxy.controller';
import { AdminFeaturedPlacementsProxyController } from './admin-featured-placements-proxy.controller';
import { AdminImpersonationProxyController } from './admin-impersonation-proxy.controller';
import { AdminJournalsProxyController } from './admin-journals-proxy.controller';
import { AdminOrgSecurityPoliciesProxyController } from './admin-org-security-policies-proxy.controller';
import { AdminPeriodEventsProxyController } from './admin-period-events-proxy.controller';
import { AdminRbacCatalogProxyController } from './admin-rbac-catalog-proxy.controller';
import { AdminRoleApprovalsProxyController } from './admin-role-approvals-proxy.controller';
import { AdminRoleAssignmentsProxyController } from './admin-role-assignments-proxy.controller';
import { AdminRolesProxyController } from './admin-roles-proxy.controller';
import { AdminSaasMetricsProxyController } from './admin-saas-metrics-proxy.controller';
import { AdminSearchRankingConfigProxyController } from './admin-search-ranking-config-proxy.controller';
import { AdminSearchRelevanceProxyController } from './admin-search-relevance-proxy.controller';
import { AdminSubscriptionsProxyController } from './admin-subscriptions-proxy.controller';
import { AdminTrialBalanceProxyController } from './admin-trial-balance-proxy.controller';
import { AdminUsersProxyController } from './admin-users-proxy.controller';
import { AuthProxyMetrics } from './auth-proxy-metrics';
import { AuthProxyController } from './auth-proxy.controller';
import { BookingLifecycleProxyController } from './booking-lifecycle-proxy.controller';
import { BookingsProxyController } from './bookings-proxy.controller';
import { CheckoutSessionsProxyController } from './checkout-sessions-proxy.controller';
import { ConciergeAssignmentsProxyController } from './concierge-assignments-proxy.controller';
import { ConciergeEmergencyProxyController } from './concierge-emergency-proxy.controller';
import { ConciergeEnrichmentSummariesProxyController } from './concierge-enrichment-summaries-proxy.controller';
import { ConciergeOnboardingProxyController } from './concierge-onboarding-proxy.controller';
import { ConciergeRequestsProxyController } from './concierge-requests-proxy.controller';
import { FavoriteProvidersProxyController } from './favorite-providers-proxy.controller';
import { BillingPortalProxyController } from './billing-portal-proxy.controller';
import { MySubscriptionProxyController } from './my-subscription-proxy.controller';
import { InvoicesProxyController } from './invoices-proxy.controller';
import { HouseholdScopeModule } from '../household-scope/household-scope.module';
import { MeController } from './me.controller';
import { PlansProxyController } from './plans-proxy.controller';
import { ProvidersProxyController } from './providers-proxy.controller';
import { SavedSearchesProxyController } from './saved-searches-proxy.controller';
import { SearchClicksProxyController } from './search-clicks-proxy.controller';
import { SearchProvidersProxyController } from './search-providers-proxy.controller';
import { SeniorPhotosAggregatorController } from './senior-photos-aggregator.controller';
import { SeniorRecommendationsAggregatorController } from './senior-recommendations-aggregator.controller';
import {
  MeSeniorsProxyController,
  SeniorAlertPreferencesProxyController,
  SeniorConsentProxyController,
  SeniorPreferencesProxyController,
} from './senior-profile-proxy.controller';
import { VisitPrepAggregatorController } from './visit-prep-aggregator.controller';
import { WellnessAnomalyAggregatorController } from './wellness-anomaly-aggregator.controller';
import { WellnessTrendsAggregatorController } from './wellness-trends-aggregator.controller';

/**
 * Phase-1 gateway routes.
 *
 *   - `GET /api/v1/me`           — TS-140 actor-identity readback
 *                                  derived from the verified access
 *                                  token. No downstream call.
 *
 *   - `GET /api/v1/plans`        — TS-140 proxy to service-subscription
 *                                  plan catalog. Exercises the full
 *                                  trust-header + timeout + response-
 *                                  classification pipeline end-to-end.
 *
 *   - `POST /api/v1/auth/{signup,login,refresh}` — TS-121 web-family
 *                                  BFF auth proxies. Public surfaces
 *                                  (no `AccessTokenGuard`) under the
 *                                  `sensitive` rate-limit policy.
 *                                  Propagate `Set-Cookie` for the
 *                                  refresh-token rotation cookie.
 *
 *   - `POST /api/v1/auth/mfa/verify` — TS-123 web-admin BFF proxy for
 *                                  the second step of the MFA login
 *                                  flow. Public (consumes the single-
 *                                  use challenge JWT), same `sensitive`
 *                                  rate-limit policy, same Set-Cookie
 *                                  propagation as login.
 *
 *   - `POST /api/v1/subscriptions/checkout-sessions`
 *   - `GET  /api/v1/subscriptions/checkout-sessions/:id`
 *   - `POST /api/v1/subscriptions/checkout-sessions/:id/finalize`
 *                                  TS-124 BFF proxies for the Stripe
 *                                  Checkout hosted-page flow. All three
 *                                  authenticated under the default
 *                                  rate-limit policy.
 *
 *   - `GET /api/v1/invoices?subscriptionId=...`
 *                                  TS-124 read-through proxy for Stripe
 *                                  invoices keyed by a local
 *                                  subscription id. Household-scoped
 *                                  downstream since
 *                                  TS-124-followup-scoping.
 *
 *   - `GET /api/v1/subscriptions/me`
 *                                  TS-042-followup-3a3-followup-1a — the
 *                                  family's own membership. The FIRST
 *                                  family-facing subscription read on the
 *                                  platform. No id: the household comes
 *                                  from signed actor context.
 *
 *   - `POST /api/v1/billing/portal-sessions`
 *                                  TS-042-followup-3a3-followup-1 proxy
 *                                  for the Stripe Billing Portal. Takes
 *                                  NO body fields — the billing customer
 *                                  comes from the caller's household
 *                                  scope, which travels as signed trust
 *                                  context rather than as a parameter.
 *
 *   - `POST /api/v1/search/providers`
 *                                  TS-125 BFF proxy for the
 *                                  provider-discovery search. Forwards
 *                                  the authenticated request to
 *                                  service-search and returns hits +
 *                                  facets.
 *
 *   - `POST /api/v1/bookings/concierge-request`
 *   - `GET  /api/v1/bookings?householdId=...`
 *   - `GET  /api/v1/bookings/:id`
 *                                  TS-125 BFF proxies for the family-
 *                                  portal manual-matching booking
 *                                  request flow. The downstream
 *                                  concierge-request endpoint derives
 *                                  pricing from a platform-default
 *                                  service-kind catalog so families
 *                                  never enter dollar amounts.
 *
 *   - `GET  /api/v1/admin/users?q=&status=&roleName=&cursor=&limit=`
 *   - `GET  /api/v1/admin/users/:id`
 *   - `POST /api/v1/admin/users/:id/suspend`
 *   - `POST /api/v1/admin/users/:id/reinstate`
 *   - `POST /api/v1/admin/users/:id/unlock`
 *                                  TS-126 Slice 1 + TS-126-followup-1
 *                                  BFF proxies for the admin users
 *                                  management surfaces. All gated by
 *                                  SuperAdminRoleGuard at the edge;
 *                                  the downstream service-identity
 *                                  guard enforces the same gate for
 *                                  defence-in-depth. Mutation proxies
 *                                  forward the inbound `Idempotency-Key`
 *                                  header so the downstream `@Idempotent()`
 *                                  interceptor can collapse a client-side
 *                                  retry against the cached response.
 *
 *   - `GET /api/v1/admin/subscriptions?customerGroup=&status=&planId=&customerId=&cursor=&limit=`
 *   - `GET /api/v1/admin/subscriptions/:id`
 *                                  TS-127 Slice 1 BFF proxies for the
 *                                  admin subscriptions management
 *                                  surfaces. Both gated by
 *                                  SuperAdminRoleGuard at the edge; the
 *                                  downstream service-subscription
 *                                  guard enforces the same gate for
 *                                  defence-in-depth.
 *
 *   - `GET /api/v1/admin/bookings?householdId=&providerId=&seniorId=&serviceKind=&status=&cursor=&limit=`
 *   - `GET /api/v1/admin/bookings/:id`
 *                                  TS-128 Slice 1 BFF proxies for the
 *                                  admin bookings management surfaces.
 *                                  Both gated by SuperAdminRoleGuard at
 *                                  the edge; the downstream
 *                                  service-booking guard enforces the
 *                                  same gate for defence-in-depth.
 *
 *   - `GET    /api/v1/admin/search/ranking-config`
 *   - `GET    /api/v1/admin/search/ranking-config/:regionCode`
 *   - `PUT    /api/v1/admin/search/ranking-config/:regionCode`
 *   - `DELETE /api/v1/admin/search/ranking-config/:regionCode`
 *                                  TS-211-followup-1 BFF proxies for
 *                                  the admin search ranking-config
 *                                  surface. All four gated by
 *                                  SuperAdminRoleGuard at the edge;
 *                                  service-search's
 *                                  InternalSharedSecretGuard enforces
 *                                  the secret-pinned trust posture for
 *                                  defence-in-depth. The proxy stamps
 *                                  the authenticated actor's userId
 *                                  into the PUT body's updatedByUserId
 *                                  field so ops audit captures who
 *                                  last tweaked the weights. Forwards
 *                                  `Idempotency-Key` on PUT so a
 *                                  client-side retry can collapse
 *                                  against any future @Idempotent()
 *                                  decoration; today the upsert is
 *                                  naturally idempotent (byte-equal
 *                                  replay → `unchanged`). Returns 503
 *                                  with a specific detail line when
 *                                  SEARCH_INDEX_API_KEY is unset on
 *                                  the gateway env.
 *
 *   - `GET    /api/v1/admin/search/featured-placements?providerId=&activeOnly=&limit=`
 *   - `POST   /api/v1/admin/search/featured-placements`
 *   - `DELETE /api/v1/admin/search/featured-placements/:placementId`
 *                                  TS-207 BFF proxies for the admin
 *                                  featured-placement scheduling surface.
 *                                  All three gated by SuperAdminRoleGuard at
 *                                  the edge; service-search's
 *                                  InternalSharedSecretGuard enforces the
 *                                  secret-pinned trust posture for
 *                                  defence-in-depth. The proxy stamps the
 *                                  authenticated actor's userId into the
 *                                  POST body's createdByUserId field for ops
 *                                  attribution, forwards `Idempotency-Key`
 *                                  on the schedule POST, and returns 503 with
 *                                  a specific detail line when
 *                                  SEARCH_INDEX_API_KEY is unset on the
 *                                  gateway env.
 *
 *   - `GET /api/v1/admin/journals?periodId=&periodName=&kind=&cursor=&limit=`
 *   - `GET /api/v1/admin/journals/:id`
 *   - `GET /api/v1/admin/trial-balance?periodId=&periodName=&currency=`
 *   - `GET /api/v1/admin/periods/:periodName/events?cursor=&limit=`
 *                                  TS-129 Slice 1 BFF proxies for the
 *                                  admin accounting view (recent
 *                                  journals, trial balance read-only,
 *                                  per-period lifecycle audit). All four
 *                                  gated by SuperAdminRoleGuard at the
 *                                  edge; the downstream service-accounting
 *                                  guard enforces the same gate for
 *                                  defence-in-depth.
 *
 *   - `GET   /api/v1/admin/accounts?activeOnly=&type=&parentId=`
 *   - `PATCH /api/v1/admin/accounts/:id`
 *                                  TS-129-followup-1 BFF proxies for the
 *                                  chart-of-accounts admin browser. The
 *                                  read passes through to service-
 *                                  accounting's existing public
 *                                  `GET /api/v1/accounts`; the PATCH
 *                                  routes to the admin-gated
 *                                  `PATCH /api/v1/admin/accounts/:id`.
 *                                  Both gated by SuperAdminRoleGuard at
 *                                  the edge; the downstream guard
 *                                  enforces the same gate on the PATCH
 *                                  for defence-in-depth. The PATCH
 *                                  forwards `Idempotency-Key` through so
 *                                  the downstream `@Idempotent()`
 *                                  interceptor can collapse retries.
 *
 *   - `GET /api/v1/bookings/:bookingId/prep-checklist`
 *                                  TS-208 BFF aggregator for the
 *                                  provider-facing "visit prep
 *                                  checklist" surface. Authenticated
 *                                  under the default rate-limit policy.
 *                                  Aggregates the booking row (service-
 *                                  booking) + the actor's own provider
 *                                  profile snapshot (service-provider)
 *                                  + the senior's operational intake +
 *                                  memory recipes (service-household
 *                                  via the internal shared-secret
 *                                  endpoint). Authz: actor must be the
 *                                  assigned provider for the booking.
 *
 *   - `PUT /api/v1/providers/:providerId/profile`
 *                                  TS-200 BFF proxy for the provider-
 *                                  portal self-service profile editor.
 *                                  Authenticated under the default
 *                                  rate-limit policy. The downstream
 *                                  service-provider handler enforces
 *                                  row ownership (the authenticated
 *                                  user's `sub` must match
 *                                  `providers.user_id`). The proxy
 *                                  forwards `Idempotency-Key` through
 *                                  so the downstream `@Idempotent()`
 *                                  interceptor can collapse retries.
 *
 *   - `GET   /api/v1/me/seniors`
 *   - `GET   /api/v1/seniors/:seniorId/preferences`
 *   - `PATCH /api/v1/seniors/:seniorId/preferences`
 *                                  TS-214 BFF proxies for the family-
 *                                  portal senior preference editor.
 *                                  Authenticated under the default
 *                                  rate-limit policy; forward to
 *                                  service-household. `GET /me/seniors`
 *                                  is the directory the editor lists
 *                                  from; the per-senior GET/PATCH read +
 *                                  bulk-merge-upsert the memory profile.
 *                                  The downstream enforces household
 *                                  membership (403 for a non-member).
 *                                  The PATCH proxy forwards
 *                                  `Idempotency-Key` so a retry collapses
 *                                  against the downstream `@Idempotent()`
 *                                  cached response.
 *
 *   - `GET /api/v1/seniors/:seniorId/recommended-providers`
 *                                  TS-213 BFF aggregator for the family-
 *                                  portal match-recommendations surface.
 *                                  Authenticated under the default
 *                                  rate-limit policy. Reads the senior's
 *                                  preferences with the actor token (authz
 *                                  gate + cuisine cues), the operational
 *                                  intake via the household internal
 *                                  shared-secret prep-snapshot, then calls
 *                                  service-search's internal recommendations
 *                                  endpoint with a DE-IDENTIFIED signal
 *                                  profile (no seniorId / PII crosses to
 *                                  service-search — CLAUDE.md §2.3, §12).
 *                                  Returns 503 with a specific detail line
 *                                  when either shared secret
 *                                  (HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY /
 *                                  SEARCH_INDEX_API_KEY) is unset.
 *
 *   - `GET /api/v1/seniors/:seniorId/photos?limit=&cursor=`
 *                                  TS-232 BFF aggregator for the family-
 *                                  portal consent-gated photo gallery.
 *                                  Authenticated under the default rate-
 *                                  limit policy. Reads the senior's consent
 *                                  record (service-household, TS-238) with
 *                                  the actor token — BOTH the consent gate
 *                                  AND the household-membership gate (a non-
 *                                  member gets the downstream 403/404
 *                                  verbatim) — then, only when the caller
 *                                  may see photos (manager / senior, or an
 *                                  observer the senior shared `photos` with),
 *                                  lists the senior's `ready` `senior_photo`
 *                                  assets from service-media. Default opt-out
 *                                  (CLAUDE.md §12): `shared: false` + empty
 *                                  gallery when the senior has not shared.
 *                                  Requires HOUSEHOLD_SERVICE_BASE_URL +
 *                                  MEDIA_SERVICE_BASE_URL.
 *
 *   - `GET /api/v1/seniors/:seniorId/wellness-trends?windowDays=`
 *                                  TS-231 BFF aggregator for the family-
 *                                  portal consent-gated wellness trends.
 *                                  Reads the senior's consent record
 *                                  (service-household, TS-238) with the
 *                                  actor token — BOTH the consent gate AND
 *                                  the membership gate — then, only when
 *                                  the caller may see the `notes` surface
 *                                  (manager / senior, or an observer the
 *                                  senior shared `notes` with), reads the
 *                                  per-visit wellness-trend series from
 *                                  service-booking. Default opt-out
 *                                  (CLAUDE.md §12): `shared: false` + empty
 *                                  series when the senior has not shared.
 *                                  Requires HOUSEHOLD_SERVICE_BASE_URL +
 *                                  BOOKING_SERVICE_BASE_URL.
 *
 *   - `GET /api/v1/seniors/:seniorId/wellness-anomalies?windowDays=`
 *                                  TS-236 BFF aggregator for the family-
 *                                  portal consent-gated wellness-anomaly
 *                                  early-warning flags. Same two-hop shape
 *                                  + `notes` consent gate as the wellness
 *                                  trends above: reads the consent record
 *                                  (service-household) with the actor token,
 *                                  then — only when the caller may see the
 *                                  `notes` surface — reads the decline flags
 *                                  from service-booking. Default opt-out:
 *                                  `shared: false` + empty `flags` when not
 *                                  shared. Requires HOUSEHOLD_SERVICE_BASE_URL
 *                                  + BOOKING_SERVICE_BASE_URL.
 *
 *   - `POST   /api/v1/admin/concierge/assignments`
 *   - `GET    /api/v1/admin/concierge/assignments?householdId=…`
 *   - `DELETE /api/v1/admin/concierge/assignments/:assignmentId`
 *   - `GET    /api/v1/concierge/assignments/me`
 *                                  TS-222 BFF proxies for the dedicated
 *                                  culinary-concierge assignment surface.
 *                                  The three admin routes gate on
 *                                  SuperAdminRoleGuard at the edge and
 *                                  forward to service-concierge (which
 *                                  enforces the same gate for defence-in-
 *                                  depth); the create proxy stamps the
 *                                  authenticated actor's userId into the
 *                                  body's `assignedByUserId` and forwards
 *                                  `Idempotency-Key` on POST + DELETE. The
 *                                  family `/me` route is AccessTokenGuard-
 *                                  only and renders the "Your concierge"
 *                                  card — service-concierge resolves the
 *                                  household from the token `tenantScope`.
 *                                  Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `POST /api/v1/concierge/requests`
 *   - `GET  /api/v1/concierge/requests/me`
 *                                  TS-223 BFF proxies for the family-portal
 *                                  concierge custom-request submission +
 *                                  "my requests" list. Both
 *                                  AccessTokenGuard-only (household-scoped);
 *                                  service-concierge resolves the household
 *                                  from the token `tenantScope`, routes the
 *                                  ticket to the household's active primary
 *                                  concierge, and stamps a per-kind SLA. The
 *                                  submit proxy re-validates the body at the
 *                                  gateway and forwards `Idempotency-Key`.
 *                                  Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `POST /api/v1/concierge/emergency`
 *                                  TS-225 BFF proxy for the family-portal
 *                                  emergency concierge-assistance trigger.
 *                                  AccessTokenGuard-only (household-scoped);
 *                                  service-concierge resolves the household
 *                                  from the token `tenantScope`, opens a
 *                                  high-severity escalated ticket, and pages
 *                                  the on-call supervisor via PagerDuty. The
 *                                  proxy re-validates the body at the gateway
 *                                  and forwards `Idempotency-Key` so a panicked
 *                                  double-tap collapses. Reachable by any
 *                                  household (no Tier-3 hard gate — a safety
 *                                  surface). Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `GET  /api/v1/admin/concierge/tickets`
 *   - `GET  /api/v1/admin/concierge/tickets/:ticketId`
 *   - `POST /api/v1/admin/concierge/tickets/:ticketId/transition`
 *   - `POST /api/v1/admin/concierge/tickets/:ticketId/escalate`
 *   - `POST /api/v1/admin/concierge/tickets/:ticketId/notes`
 *                                  TS-224 BFF proxies for the concierge ops
 *                                  console (SLA-ordered queue + detail +
 *                                  status transitions + escalation + internal
 *                                  notes). Gated on `PermissionGuard` —
 *                                  `concierge:read` for the reads,
 *                                  `concierge:write` for the mutations — the
 *                                  FIRST gateway proxy to use the lifted
 *                                  permission guard rather than
 *                                  SuperAdminRoleGuard. The three POST proxies
 *                                  re-validate the body at the gateway and
 *                                  forward `Idempotency-Key`. service-concierge
 *                                  enforces the same permission gate (defence-
 *                                  in-depth). Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `GET   /api/v1/admin/concierge/scheduled-events?householdId=&ticketId=&status=&kind=&upcomingOnly=&limit=`
 *   - `POST  /api/v1/admin/concierge/scheduled-events`
 *   - `PATCH /api/v1/admin/concierge/scheduled-events/:eventId`
 *                                  TS-227 BFF proxies for the concierge
 *                                  scheduled-events surface (event dining +
 *                                  social outings fulfilment). Gated on
 *                                  `PermissionGuard` — `concierge:read` for the
 *                                  list, `concierge:write` for schedule +
 *                                  update — like TS-224. The POST + PATCH
 *                                  proxies re-validate the body at the gateway
 *                                  and forward `Idempotency-Key`; the actor
 *                                  propagates via the trust envelope and
 *                                  service-concierge stamps `createdByUserId`
 *                                  from the token. service-concierge enforces
 *                                  the same gate (defence-in-depth). Requires
 *                                  CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `GET   /api/v1/admin/concierge/onboardings?householdId=&status=&limit=`
 *   - `POST  /api/v1/admin/concierge/onboardings`
 *   - `GET   /api/v1/admin/concierge/onboardings/:onboardingId`
 *   - `PATCH /api/v1/admin/concierge/onboardings/:onboardingId`
 *   - `PATCH /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey`
 *   - `GET   /api/v1/concierge/onboarding/me`
 *                                  TS-228 BFF proxies for the Tier-3 onboarding
 *                                  ("white-glove kickoff") checklist. The five
 *                                  admin routes gate on `PermissionGuard` —
 *                                  `concierge:read` for the reads,
 *                                  `concierge:write` for the mutations — like
 *                                  TS-224 / TS-227. The POST + PATCH proxies
 *                                  re-validate the body at the gateway and
 *                                  forward `Idempotency-Key`; the actor
 *                                  propagates via the trust envelope and
 *                                  service-concierge stamps
 *                                  `started_by_user_id` / `completed_by_user_id`
 *                                  from the token. The family `/me` route is
 *                                  AccessTokenGuard-only (household-scoped) and
 *                                  powers the read-only "Your onboarding" card —
 *                                  service-concierge resolves the household from
 *                                  the token `tenantScope`. service-concierge
 *                                  enforces the same gates (defence-in-depth).
 *                                  Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `GET   /api/v1/admin/concierge/enrichment-summaries?householdId=&status=&limit=`
 *   - `POST  /api/v1/admin/concierge/enrichment-summaries`
 *   - `GET   /api/v1/admin/concierge/enrichment-summaries/:summaryId`
 *   - `PATCH /api/v1/admin/concierge/enrichment-summaries/:summaryId`
 *   - `GET   /api/v1/concierge/enrichment-summaries/me`
 *   - `GET   /api/v1/concierge/enrichment-summaries/me/:summaryId`
 *                                  TS-229 BFF proxies for the Tier-3 weekly
 *                                  enrichment summary. The four admin routes
 *                                  gate on `PermissionGuard` — `concierge:read`
 *                                  for the reads, `concierge:write` for the
 *                                  mutations — like TS-224 / TS-227 / TS-228.
 *                                  The POST + PATCH proxies re-validate the body
 *                                  at the gateway and forward `Idempotency-Key`;
 *                                  the actor propagates via the trust envelope
 *                                  and service-concierge stamps
 *                                  `authored_by_user_id` / `published_by_user_id`
 *                                  from the token. The two family `/me` routes
 *                                  are AccessTokenGuard-only (household-scoped)
 *                                  and power the read-only dashboard list + the
 *                                  per-week permalink (PUBLISHED summaries only)
 *                                  — service-concierge resolves the household
 *                                  from the token `tenantScope`. service-concierge
 *                                  enforces the same gates (defence-in-depth).
 *                                  Requires CONCIERGE_SERVICE_BASE_URL.
 *
 *   - `GET    /api/v1/admin/academy/courses?status=&track=&kind=&includeDeleted=&limit=`
 *   - `POST   /api/v1/admin/academy/courses`
 *   - `GET    /api/v1/admin/academy/courses/:courseId`
 *   - `PATCH  /api/v1/admin/academy/courses/:courseId`
 *   - `DELETE /api/v1/admin/academy/courses/:courseId`
 *   - `GET    /api/v1/admin/academy/courses/:courseId/modules`
 *   - `POST   /api/v1/admin/academy/courses/:courseId/modules`
 *   - `PATCH  /api/v1/admin/academy/modules/:moduleId`
 *   - `DELETE /api/v1/admin/academy/modules/:moduleId`
 *   - `GET    /api/v1/admin/academy/modules/:moduleId/lessons`
 *   - `POST   /api/v1/admin/academy/modules/:moduleId/lessons`
 *   - `PATCH  /api/v1/admin/academy/lessons/:lessonId`
 *   - `DELETE /api/v1/admin/academy/lessons/:lessonId`
 *   - `GET    /api/v1/admin/academy/courses/:courseId/cohorts?status=&includeDeleted=&limit=`
 *   - `POST   /api/v1/admin/academy/courses/:courseId/cohorts`
 *   - `PATCH  /api/v1/admin/academy/cohorts/:cohortId`
 *   - `DELETE /api/v1/admin/academy/cohorts/:cohortId`
 *                                  TS-251 BFF proxies for the Cooking Academy
 *                                  course-catalog admin surface (course →
 *                                  module → lesson hierarchy + course cohorts).
 *                                  All gated on `PermissionGuard` —
 *                                  `academy:read` for the reads, `academy:write`
 *                                  for the mutations — like the TS-224 / TS-227
 *                                  concierge admin proxies. The POST / PATCH /
 *                                  DELETE proxies forward `Idempotency-Key`; the
 *                                  POST / PATCH proxies re-validate the body at
 *                                  the gateway. The lesson DELETE returns 204 No
 *                                  Content; the course / cohort DELETEs return
 *                                  200 with the soft-deleted record; the module
 *                                  DELETE returns 200 with the cascade count.
 *                                  Forward to service-academy at the SAME path;
 *                                  service-academy enforces the same gates
 *                                  (defence-in-depth). Requires
 *                                  ACADEMY_SERVICE_BASE_URL.
 *
 *   - `GET   /api/v1/admin/ads/placements`
 *   - `GET   /api/v1/admin/ads/slot-schedules?placementId=&campaignId=&status=&limit=`
 *   - `POST  /api/v1/admin/ads/slot-schedules`
 *   - `GET   /api/v1/admin/ads/slot-schedules/:scheduleId`
 *   - `PATCH /api/v1/admin/ads/slot-schedules/:scheduleId`
 *                                  TS-272a BFF proxies for the ads slot-
 *                                  inventory admin surface (read the seeded
 *                                  placements + book campaigns into them over a
 *                                  delivery window). All gated on
 *                                  `PermissionGuard` — `ads:read` for the reads,
 *                                  `ads:write` for the mutations — like the
 *                                  TS-271b ad-campaigns proxy. The POST / PATCH
 *                                  proxies re-validate the body at the gateway
 *                                  and forward `Idempotency-Key`; the actor
 *                                  propagates via the trust envelope (never the
 *                                  body). Forward to service-ads at the SAME
 *                                  path; service-ads enforces the same gates
 *                                  (defence-in-depth). Requires
 *                                  ADS_SERVICE_BASE_URL.
 *
 *   - `GET   /api/v1/admin/ads/creatives/review-queue?limit=`
 *   - `GET   /api/v1/admin/ads/creatives/:creativeId/review`
 *   - `PATCH /api/v1/admin/ads/creatives/:creativeId/accessibility`
 *   - `POST  /api/v1/admin/ads/creatives/:creativeId/review`
 *                                  TS-277b BFF proxies for the ads creative
 *                                  approval workflow (review queue + decision +
 *                                  accessibility metadata). Two trust tiers: the
 *                                  review surface (queue / detail / decision) is
 *                                  gated on `marketing:approve_creative` so the
 *                                  campaign author cannot self-approve; the
 *                                  accessibility-metadata edit is the author's
 *                                  `ads:write`. The PATCH / POST proxies
 *                                  re-validate the body and forward
 *                                  `Idempotency-Key`; the actor propagates via
 *                                  the trust envelope (never the body). Forward
 *                                  to service-ads at the SAME path; service-ads
 *                                  enforces the same gates (defence-in-depth).
 *                                  Requires ADS_SERVICE_BASE_URL.
 */
@Module({
  // TS-505d2-followup-5a — MeController now reports the actor's household
  // memberships, which HouseholdScopeModule owns (and has already warmed on
  // this request via the global interceptor).
  imports: [RateLimitModule, ServiceRegistryModule, HouseholdScopeModule],
  controllers: [
    MeController,
    PlansProxyController,
    AuthProxyController,
    CheckoutSessionsProxyController,
    InvoicesProxyController,
    MySubscriptionProxyController,
    BillingPortalProxyController,
    SearchProvidersProxyController,
    SearchClicksProxyController,
    BookingsProxyController,
    BookingLifecycleProxyController,
    AdminUsersProxyController,
    AdminImpersonationProxyController,
    AdminRoleAssignmentsProxyController,
    AdminRoleApprovalsProxyController,
    AdminRolesProxyController,
    AdminRbacCatalogProxyController,
    AdminOrgSecurityPoliciesProxyController,
    AdminSubscriptionsProxyController,
    AdminAuditEventsProxyController,
    AdminBookingsProxyController,
    AdminSearchRankingConfigProxyController,
    AdminFeaturedPlacementsProxyController,
    AdminJournalsProxyController,
    AdminTrialBalanceProxyController,
    AdminDeferredRevenueProxyController,
    AdminSaasMetricsProxyController,
    AdminSearchRelevanceProxyController,
    AdminPeriodEventsProxyController,
    AdminChartOfAccountsProxyController,
    AdminConciergeAssignmentsProxyController,
    AdminConciergeOpsProxyController,
    AdminConciergeScheduledEventsProxyController,
    AdminConciergeTransportationProxyController,
    AdminConciergeOnboardingsProxyController,
    AdminConciergeEnrichmentSummariesProxyController,
    AdminAcademyCoursesProxyController,
    AdminAcademyModulesProxyController,
    AdminAcademyLessonsProxyController,
    AdminAcademyCohortsProxyController,
    AdminAdsCampaignsProxyController,
    AdminAdsSlotsProxyController,
    AdminAdsCreativesProxyController,
    AdminContentArticlesProxyController,
    AdminContentAuthorsProxyController,
    AdminContentHelpCategoriesProxyController,
    AdminMediaAssetsProxyController,
    MfaProxyController,
    ContentFeedbackProxyController,
    PublicBlogProxyController,
    ProvidersProxyController,
    VisitPrepAggregatorController,
    ConciergeAssignmentsProxyController,
    ConciergeRequestsProxyController,
    ConciergeEmergencyProxyController,
    TrustSafetyIncidentsProxyController,
    AdminTrustSafetyIncidentsProxyController,
    // TS-309a-followup-1 — the Privacy Center. Two controllers because the
    // requester's routes carry NO permission gate (the gate is being the
    // requester) and the operator's are `privacy:read` / `privacy:write`.
    PrivacyRequestsProxyController,
    AdminPrivacyRequestsProxyController,
    AdminTrustSafetyMandatedReporterProxyController,
    AdminProvider360AggregatorController,
    AdminProvidersProxyController,
    AdminBookingHoldsProxyController,
    ConciergeOnboardingProxyController,
    ConciergeEnrichmentSummariesProxyController,
    SavedSearchesProxyController,
    FavoriteProvidersProxyController,
    MeSeniorsProxyController,
    SeniorAlertPreferencesProxyController,
    SeniorConsentProxyController,
    SeniorPreferencesProxyController,
    SeniorPhotosAggregatorController,
    SeniorRecommendationsAggregatorController,
    WellnessAnomalyAggregatorController,
    WellnessTrendsAggregatorController,
  ],
  // TS-121-followup-9 — the auth-proxy outcome counter. Provider-only:
  // `AuthProxyController` is its single consumer, and the outcomes it
  // separates (`session` vs `challenge`, both 200s) exist only at that
  // controller's response mapper.
  providers: [AuthProxyMetrics],
})
export class GatewayRoutesModule {}
