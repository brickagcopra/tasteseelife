import { describe, expect, it } from 'vitest';

import { generateOpenApiDocument } from '../openapi';

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly components?: {
    readonly schemas?: Readonly<Record<string, unknown>>;
  };
}

const document = generateOpenApiDocument() as OpenApiDocument;

describe('generated OpenAPI document', () => {
  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('carries the platform info block', () => {
    expect(document.info.title).toMatch(/Taste & See/i);
    expect(document.info.version).toBeTruthy();
  });

  it('registers the Plan schema under components.schemas', () => {
    expect(document.components?.schemas?.['Plan']).toBeDefined();
  });

  it('registers the PlansListResponse schema under components.schemas', () => {
    expect(document.components?.schemas?.['PlansListResponse']).toBeDefined();
  });

  it('registers the MfaRecoveryVerifyRequest schema (TS-023-followup-2)', () => {
    expect(document.components?.schemas?.['MfaRecoveryVerifyRequest']).toBeDefined();
  });

  it('MfaConfirmResponse carries the recoveryCodes property (TS-023-followup-2)', () => {
    const schema = document.components?.schemas?.['MfaConfirmResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;
    expect(schema?.properties?.['recoveryCodes']).toBeDefined();
    expect(schema?.required).toContain('recoveryCodes');
  });

  it('Plan schema has every required Zod field as an OpenAPI property', () => {
    const planSchema = document.components?.schemas?.['Plan'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(planSchema).toBeDefined();
    const expectedProps = [
      'id',
      'code',
      'name',
      'customerGroup',
      'monthlyPriceUsdMinor',
      'annualPriceUsdMinor',
      'currency',
      'features',
      'active',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(planSchema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('is deterministic across calls (stable serialization for drift detection)', () => {
    const a = JSON.stringify(generateOpenApiDocument());
    const b = JSON.stringify(generateOpenApiDocument());
    expect(a).toBe(b);
  });

  // TS-126-followup-9 — admin-users surface schemas land alongside the
  // existing HTTP DTOs so the web-admin type-generation pipeline picks
  // them up.
  it.each([
    'AdminUserMfaSummary',
    'AdminUserKycSummary',
    'AdminUserLockoutSummary',
    'AdminUserSummary',
    'AdminUsersListQuery',
    'AdminUsersListResponse',
    'AdminUserDetail',
    'AdminUserDetailResponse',
  ])('registers the %s admin-users schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdminUserDetail carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdminUserDetail'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'email',
      'phone',
      'status',
      'mfaEnabled',
      'emailVerifiedAt',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'roles',
      'holdsAdminRole',
      'mfaMethods',
      'latestKyc',
      'lockout',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-127-followup-9 — admin-subscriptions surface schemas land alongside
  // the existing HTTP DTOs so the web-admin type-generation pipeline picks
  // them up.
  it.each([
    'AdminSubscriptionPlanSummary',
    'AdminSubscriptionPaymentMethodSummary',
    'AdminSubscriptionDunningSummary',
    'AdminSubscriptionPauseSummary',
    'AdminSubscriptionSummary',
    'AdminSubscriptionsListQuery',
    'AdminSubscriptionsListResponse',
    'AdminSubscriptionHistoryEntry',
    'AdminSubscriptionDetail',
    'AdminSubscriptionDetailResponse',
  ])('registers the %s admin-subscriptions schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdminSubscriptionDetail carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdminSubscriptionDetail'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'stripeSubscriptionId',
      'stripeCustomerId',
      'customerId',
      'customerGroup',
      'status',
      'billingInterval',
      'unitPriceMinor',
      'currency',
      'currentPeriodStart',
      'currentPeriodEnd',
      'trialEnd',
      'cancelAtPeriodEnd',
      'cancelReason',
      'canceledAt',
      'createdAt',
      'updatedAt',
      'plan',
      'defaultPaymentMethod',
      'dunning',
      'pause',
      'history',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-128-followup-10 — admin-bookings surface schemas land alongside
  // the existing HTTP DTOs so the web-admin type-generation pipeline picks
  // them up.
  it.each([
    'AdminBookingVisitNoteSummary',
    'AdminBookingCheckInSummary',
    'AdminBookingDisputeSummary',
    'AdminBookingRecurrenceSummary',
    'AdminBookingSummary',
    'AdminBookingsListQuery',
    'AdminBookingsListResponse',
    'AdminBookingDetail',
    'AdminBookingDetailResponse',
  ])('registers the %s admin-bookings schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdminBookingDetail carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdminBookingDetail'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'householdId',
      'seniorId',
      'providerId',
      'serviceKind',
      'status',
      'scheduledStart',
      'scheduledEnd',
      'currency',
      'basePriceMinor',
      'commissionRateBps',
      'commissionAmountMinor',
      'finalPriceMinor',
      'bookingNotes',
      'completedAt',
      'canceledAt',
      'cancellationReason',
      'cancellationReasonText',
      'createdAt',
      'updatedAt',
      'visitNote',
      'checkIns',
      'disputes',
      'recurrence',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-129-followup-1a — admin chart-of-accounts mutation schemas land
  // alongside the existing HTTP DTOs so the web-admin type-generation
  // pipeline picks them up.
  it.each([
    'AdminAccountActiveReason',
    'AdminAccountActiveStateSnapshot',
    'UpdateAccountActiveRequest',
    'UpdateAccountActiveResponse',
  ])('registers the %s admin-chart-of-accounts schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('UpdateAccountActiveResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['UpdateAccountActiveResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'account',
      'performedAt',
      'performedByUserId',
      'before',
      'after',
      'reason',
      'note',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-129-followup-6 — admin-accounting surface schemas (journals list +
  // detail, trial balance, per-period lifecycle events) land alongside
  // the existing HTTP DTOs so the web-admin type-generation pipeline
  // picks them up.
  it.each([
    'AdminAccountingCurrency',
    'AdminJournalLine',
    'AdminJournalSummary',
    'AdminJournalDetail',
    'AdminJournalsListQuery',
    'AdminJournalsListResponse',
    'AdminJournalDetailResponse',
    'AdminTrialBalanceRow',
    'AdminTrialBalanceQuery',
    'AdminTrialBalanceResponse',
    'AdminPeriodEvent',
    'AdminPeriodEventsListQuery',
    'AdminPeriodEventsListResponse',
  ])('registers the %s admin-accounting schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdminJournalDetail carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdminJournalDetail'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'kind',
      'occurredAt',
      'postedAt',
      'sourceEventId',
      'description',
      'periodId',
      'periodName',
      'postedByUserId',
      'reversedJournalId',
      'reversedByJournalId',
      'totalDebitMinor',
      'totalCreditMinor',
      'currency',
      'context',
      'lines',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('AdminTrialBalanceResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdminTrialBalanceResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'rows',
      'totalDebitMinor',
      'totalCreditMinor',
      'imbalanceMinor',
      'currency',
      'periodId',
      'periodName',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-063-followup-10 — booking-domain customer-facing surfaces
  // (visit notes / check-ins / recurrence). Three sibling files
  // register together so the provider-portal + family-portal type-
  // generation pipelines pick them up alongside the existing HTTP DTOs.
  it.each([
    'VisitNoteMood',
    'VisitNoteAppetite',
    'VisitNoteHydration',
    'VisitNoteSocialEngagement',
    'UpsertVisitNotesRequest',
    'VisitNotesResponse',
    'BookingCheckInKind',
    'RecordBookingCheckInRequest',
    'BookingCheckInResponse',
    'RecordBookingCheckInResponse',
    'BookingCheckInsListResponse',
    'BookingRecurrencePattern',
    'CreateRecurringBookingRequest',
    'BookingRecurrenceRecord',
    'CreateRecurringBookingResponse',
  ])('registers the %s booking-domain schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('VisitNotesResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['VisitNotesResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'bookingId',
      'mood',
      'appetite',
      'hydration',
      'socialEngagement',
      'freeform',
      'photoKeys',
      'recordedByUserId',
      'recordedAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('RecordBookingCheckInResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['RecordBookingCheckInResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['checkIn', 'booking'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('CreateRecurringBookingResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['CreateRecurringBookingResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['recurrence', 'bookings'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-064-followup-6 — booking-tier-snapshots schemas land alongside the
  // existing booking-domain DTOs so consumers reading the published
  // OpenAPI artifact (admin tooling type-generation, internal-dispatch
  // SDK generation) pick them up.
  it.each([
    'HouseholdSubscriptionTier',
    'ProviderTierSnapshotTier',
    'UpsertHouseholdTierSnapshotRequest',
    'UpsertProviderTierSnapshotRequest',
    'HouseholdTierSnapshotResponse',
    'ProviderTierSnapshotResponse',
  ])('registers the %s booking-tier-snapshots schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('HouseholdTierSnapshotResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['HouseholdTierSnapshotResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'householdId',
      'tier',
      'lastSyncedAt',
      'sourceEventId',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('ProviderTierSnapshotResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderTierSnapshotResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'providerId',
      'tier',
      'lastSyncedAt',
      'sourceEventId',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-065-followup-9 — booking-disputes schemas land alongside the
  // existing booking-domain DTOs so consumers reading the published
  // OpenAPI artifact (admin tooling type-generation, BFF stub generation)
  // pick them up.
  it.each([
    'BookingDisputeReason',
    'BookingDisputeOpenedByRole',
    'BookingDisputeStatus',
    'TransitionableBookingDisputeStatus',
    'OpenBookingDisputeRequest',
    'UpdateBookingDisputeRequest',
    'BookingDisputeResponse',
    'BookingDisputesListResponse',
  ])('registers the %s booking-disputes schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('BookingDisputeResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['BookingDisputeResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'bookingId',
      'openedByUserId',
      'openedByRole',
      'reason',
      'reasonDetail',
      'status',
      'resolutionNotes',
      'resolvedByUserId',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-140-followup-6 — gateway-me actor surface schemas land alongside the
  // existing HTTP DTOs so the family-portal + provider-portal + admin-portal
  // type-generation pipelines pick them up.
  it.each(['MeTenantScope', 'MeRoleAssignment', 'MeResponse'])(
    'registers the %s gateway-me schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('MeResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['MeResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['userId', 'sessionId', 'mfaVerified', 'roles', 'tenantScope'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('MeRoleAssignment carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['MeRoleAssignment'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['name', 'permissions', 'scope'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-073-followup-13 — notification-dispatch + user-preferences schemas
  // land alongside the existing HTTP DTOs so the admin tooling type-
  // generation pipeline (and the future internal-dispatch SDK) pick them
  // up. The companion notification.schema.ts surface (templates + render)
  // remains the scope of TS-072-followup-12 — both follow-ups share the
  // file pair but land in separate PRs to keep each mechanically
  // reviewable.
  it.each([
    'NotificationCategory',
    'NotificationDispatchStatus',
    'NotificationSuppressionReason',
    'QuietHoursWindow',
    'PreferenceEntry',
    'UpsertPreferencesRequest',
    'ResolvedPreferenceEntry',
    'UserPreferencesResponse',
    'DispatchNotificationRequest',
    'DispatchResponse',
    'ListDispatchesQuery',
    'DispatchesListResponse',
  ])('registers the %s notification-dispatch schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('DispatchResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['DispatchResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'recipientUserId',
      'channel',
      'category',
      'templateCode',
      'locale',
      'templateVersionId',
      'recipientAddress',
      'status',
      'suppressionReason',
      'providerMessageId',
      'errorMessage',
      'idempotencyKey',
      'sourceEventId',
      'occurredAt',
      'sentAt',
      'replayed',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('UserPreferencesResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['UserPreferencesResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['userId', 'entries', 'quietHours', 'seniorMode', 'updatedAt'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-072-followup-12 — notification template + render surface schemas
  // land alongside the notification-dispatch block from TS-073-followup-13.
  // Companion follow-up: both files (notification.schema.ts +
  // notification-dispatch.schema.ts) ship in the contracts package since
  // TS-072 / TS-073 but only the dispatch half was registered prior to this
  // PR. Registering the templates half resolves the inlined-enum
  // duplication for NotificationChannelKind + NotificationLocale that
  // TS-073-followup-13's completed entry called out.
  it.each([
    'NotificationChannelKind',
    'NotificationVariableType',
    'NotificationLocale',
    'NotificationVariableEntry',
    'CreateTemplateRequest',
    'TemplateResponse',
    'ListTemplatesQuery',
    'TemplatesListResponse',
    'CreateTemplateVersionRequest',
    'TemplateVersionResponse',
    'TemplateVersionsListResponse',
    'RenderTemplateRequest',
    'RenderTemplateResponse',
    'ActivateTemplateVersionRequest',
  ])('registers the %s notification-template schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('TemplateResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['TemplateResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'code',
      'locale',
      'kind',
      'name',
      'description',
      'activeVersionId',
      'activeVersionNumber',
      'latestVersionNumber',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('TemplateVersionResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['TemplateVersionResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'templateId',
      'version',
      'subject',
      'bodyMjml',
      'bodyHtml',
      'bodyText',
      'variablesSchema',
      'isActive',
      'changeSummary',
      'createdByUserId',
      'createdAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-110-followup-14 — media-svc surface schemas land alongside the
  // existing HTTP DTOs so consumers reading the published OpenAPI artifact
  // (admin tooling type-generation via TS-126; the future media-svc SDK
  // consumers) see the upload + asset + scan-event surfaces. Twelve
  // schemas span the five lifecycle enums (`MediaAssetKind`,
  // `MediaAssetStatus`, `MediaScanStatus`, `MediaOwnerScopeKind`,
  // `MediaAssetEventKind`), the two request shapes (`IssueUploadUrlRequest`
  // + `RecordAssetEventRequest`), the canonical row response
  // (`MediaAssetResponse`), the two endpoint envelopes
  // (`IssueUploadUrlResponse` + `RecordAssetEventResponse`), and the
  // admin list pair (`ListMediaAssetsQuery` + `MediaAssetsListResponse`).
  it.each([
    'MediaAssetKind',
    'MediaAssetStatus',
    'MediaScanStatus',
    'MediaOwnerScopeKind',
    'MediaAssetEventKind',
    'IssueUploadUrlRequest',
    'RecordAssetEventRequest',
    'MediaAssetResponse',
    'IssueUploadUrlResponse',
    'RecordAssetEventResponse',
    'ListMediaAssetsQuery',
    'MediaAssetsListResponse',
  ])('registers the %s media schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('MediaAssetResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['MediaAssetResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'kind',
      'ownerUserId',
      'ownerScopeKind',
      'ownerScopeId',
      'status',
      'scanStatus',
      'scanReason',
      'declaredMime',
      'detectedMime',
      'declaredFileName',
      'declaredSizeBytes',
      'actualSizeBytes',
      'width',
      'height',
      'sha256',
      'storageBucket',
      'storageKey',
      'deliveryKey',
      'signedDeliveryUrl',
      'signedDeliveryUrlExpiresAt',
      'liveMode',
      'uploadUrlExpiresAt',
      'uploadedAt',
      'scannedAt',
      'processedAt',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('IssueUploadUrlResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['IssueUploadUrlResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'asset',
      'uploadUrl',
      'uploadMethod',
      'requiredHeaders',
      'expiresAt',
      'liveMode',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-111-followup-6 — provider-discovery surface schemas land alongside
  // the media-svc block from TS-110-followup-14. Ten schemas span the
  // three lifecycle enums (`ProviderDiscoveryTier`, `ProviderDiscoveryStatus`,
  // `ProviderDiscoverySort`), the denormalised search document
  // (`ProviderDiscoveryDocument`), the public-search request/response pair
  // (`SearchProvidersRequest` + `SearchProvidersResponse`), the internal
  // upsert request/response pair (`UpsertProviderDocumentRequest` +
  // `UpsertProviderDocumentResponse`), the internal delete response
  // (`DeleteProviderDocumentResponse`), and the read-side snapshot
  // companion (`ProviderDiscoverySnapshotResponse`) that the
  // search-indexer worker fetches from service-provider before re-indexing.
  it.each([
    'ProviderDiscoveryTier',
    'ProviderDiscoveryStatus',
    'ProviderDiscoverySort',
    'ProviderDiscoveryDocument',
    'SearchProvidersRequest',
    'SearchProvidersResponse',
    'UpsertProviderDocumentRequest',
    'UpsertProviderDocumentResponse',
    'DeleteProviderDocumentResponse',
    'ProviderDiscoverySnapshotResponse',
  ])('registers the %s provider-discovery schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ProviderDiscoveryDocument carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderDiscoveryDocument'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'providerId',
      'userId',
      'displayName',
      'headline',
      'bio',
      'tier',
      'status',
      'languages',
      'specialties',
      'cuisines',
      'dietaryExpertise',
      'certifications',
      'centroid',
      'ratingAverage',
      'ratingCount',
      'completedBookingCount',
      'profilePhotoKey',
      'videoIntroKey',
      'timeZone',
      'availabilitySummary',
      'sourceUpdatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('SearchProvidersResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['SearchProvidersResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['hits', 'facets', 'totalEstimate', 'nextCursor', 'liveMode', 'searchId'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-217-prep-4b — the search result-click ingest request/response pair
  // (`POST /api/v1/search/clicks`). Registered for parity with the public
  // `SearchProviders*` search endpoints so consumers reading the artifact see
  // the CTR-telemetry surface.
  it.each(['RecordSearchClickRequest', 'RecordSearchClickResponse'])(
    'registers the %s search-click schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('RecordSearchClickRequest carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['RecordSearchClickRequest'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['searchId', 'providerId', 'position']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-101-followup-9 — service-activity surface schemas land alongside the
  // media-svc (TS-110-followup-14) + provider-discovery (TS-111-followup-6)
  // blocks so consumers reading the published OpenAPI artifact see the
  // activity ingest + read surfaces (PDD §17.2 user activity log). Seven
  // schemas span the categorical kind enum (`ActivityEventKind`), the ingest
  // request (`RecordActivityEventRequest`), the canonical row response
  // (`ActivityEventResponse`), the ingest envelope
  // (`RecordActivityEventResponse`), the two list query shapes
  // (`ListMyActivityQuery` + `ListUserActivityQuery`), and the cursor-
  // paginated list response (`ActivityEventsListResponse`).
  it.each([
    'ActivityEventKind',
    'RecordActivityEventRequest',
    'ActivityEventResponse',
    'RecordActivityEventResponse',
    'ListMyActivityQuery',
    'ListUserActivityQuery',
    'ActivityEventsListResponse',
  ])('registers the %s activity schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ActivityEventResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ActivityEventResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'eventId',
      'userId',
      'kind',
      'occurredAt',
      'ip',
      'userAgent',
      'deviceFingerprint',
      'requestId',
      'traceId',
      'metadata',
      'createdAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-200 — provider self-service profile-edit surface. The four
  // schemas pin the wire shape of the `PUT /api/v1/providers/
  // :providerId/profile` surface + the supporting tag-kind enum
  // exposed for downstream consumers (web-provider editor,
  // search-indexer projection).
  it.each([
    'ProviderProfileTagKind',
    'UpdateProviderProfileRequest',
    'ProviderProfileRecord',
    'UpdateProviderProfileResponse',
  ])('registers the %s provider-profile schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('UpdateProviderProfileRequest carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['UpdateProviderProfileRequest'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['bio', 'languages', 'cuisines', 'dietaryExpertise', 'dementiaSensitive'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('ProviderProfileRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderProfileRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'status',
      'tier',
      'displayName',
      'headline',
      'bio',
      'profilePhotoKey',
      'videoIntroKey',
      'timeZone',
      'dementiaSensitive',
      'languages',
      'cuisines',
      'dietaryExpertise',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-203 — provider availability surface. The ten schemas pin the
  // wire shape of `GET /api/v1/providers/me/availability-snapshot`,
  // `PUT /api/v1/providers/:providerId/availability`, and
  // `DELETE /api/v1/providers/:providerId/availability`, plus the
  // supporting day-of-week enum + window/exception primitives + the
  // discovery-doc availability-summary projection.
  it.each([
    'ProviderAvailabilityWeekday',
    'ProviderAvailabilityWindow',
    'ProviderAvailabilityException',
    'ProviderAvailabilitySummaryEntry',
    'ProviderAvailabilitySummary',
    'ProviderAvailabilityRecord',
    'ProviderAvailabilitySnapshotResponse',
    'UpdateProviderAvailabilityRequest',
    'UpdateProviderAvailabilityResponse',
    'DeleteProviderAvailabilityResponse',
  ])('registers the %s provider-availability schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('UpdateProviderAvailabilityRequest carries the required windows + exceptions properties', () => {
    const schema = document.components?.schemas?.['UpdateProviderAvailabilityRequest'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['windows', 'exceptions']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('ProviderAvailabilityRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderAvailabilityRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['providerId', 'timeZone', 'windows', 'exceptions', 'updatedAt'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-206 — provider external-calendar-sync surface. Seven schemas pin
  // the wire shape of the Google Calendar connect / snapshot / sync /
  // disconnect endpoints. No token material crosses any of them.
  it.each([
    'ProviderCalendarProvider',
    'ProviderCalendarConnectionStatus',
    'ProviderCalendarConnectionRecord',
    'StartProviderCalendarConnectionResponse',
    'ProviderCalendarConnectionSnapshotResponse',
    'SyncProviderCalendarResponse',
    'DisconnectProviderCalendarResponse',
  ])('registers the %s provider-calendar-sync schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ProviderCalendarConnectionRecord carries every required Zod field + no token columns', () => {
    const schema = document.components?.schemas?.['ProviderCalendarConnectionRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'providerId',
      'calendarProvider',
      'status',
      'connectedAccountEmail',
      'externalBusyCount',
      'lastSyncedAt',
      'lastSyncError',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
    // The contract must NEVER expose any token / refresh-token material.
    for (const forbidden of ['refreshToken', 'refreshTokenCiphertext', 'accessToken']) {
      expect(
        schema?.properties?.[forbidden],
        `forbidden token property leaked: ${forbidden}`,
      ).toBeUndefined();
    }
  });

  // TS-202 — provider service-area surface. The nine schemas pin the
  // wire shape of `GET /api/v1/providers/me/service-areas-snapshot`,
  // `PUT /api/v1/providers/:providerId/service-areas`, and
  // `DELETE /api/v1/providers/:providerId/service-areas`, plus the
  // GeoJSON polygon primitive + the derived centroid / bounding-box
  // objects the search-indexer reads.
  it.each([
    'GeoPolygon',
    'GeoCentroid',
    'GeoBoundingBox',
    'ProviderServiceAreaInput',
    'ProviderServiceAreaRecord',
    'ProviderServiceAreasSnapshotResponse',
    'UpdateProviderServiceAreasRequest',
    'UpdateProviderServiceAreasResponse',
    'DeleteProviderServiceAreasResponse',
  ])('registers the %s provider-service-area schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ProviderServiceAreaRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderServiceAreaRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'providerId',
      'label',
      'polygon',
      'centroid',
      'boundingBox',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-204 — provider pricing surface. Five schemas pin the wire shape
  // of `GET /api/v1/providers/me/pricing-snapshot`,
  // `GET /api/v1/providers/:providerId/pricing`, and
  // `PUT /api/v1/providers/:providerId/pricing`, plus the platform
  // tier-band object the editor renders the allowed range from.
  it.each([
    'ProviderPricingBand',
    'UpdateProviderPricingRequest',
    'ProviderPricingRecord',
    'UpdateProviderPricingResponse',
    'ProviderPricingSnapshotResponse',
  ])('registers the %s provider-pricing schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ProviderPricingRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ProviderPricingRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'providerId',
      'status',
      'tier',
      'hourlyRateMinor',
      'currency',
      'band',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-060-followup-2 — service-catalog surface. Three schemas pin the
  // wire shape of `GET /api/v1/service-catalog` (authenticated read) and
  // `PUT /api/v1/admin/service-catalog/:kind` (super-admin upsert).
  it.each([
    'ServiceCatalogRecord',
    'ServiceCatalogListResponse',
    'UpsertServiceCatalogEntryRequest',
    'UpsertServiceCatalogEntryResponse',
  ])('registers the %s service-catalog schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ServiceCatalogRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ServiceCatalogRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'kind',
      'name',
      'description',
      'baseRateMinMinor',
      'baseRateMaxMinor',
      'durationMinutes',
      'currency',
      'active',
      'requiredProviderTier',
      'sortPosition',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-208 — visit-prep-checklist surface. The four schemas pin the
  // wire shape of `GET /api/v1/bookings/:bookingId/prep-checklist`
  // (gateway BFF aggregator) and the upstream internal
  // `GET /api/v1/internal/seniors/:seniorId/prep-snapshot` it calls.
  it.each([
    'VisitPrepChecklistBooking',
    'VisitPrepChecklistSenior',
    'VisitPrepChecklistResponse',
    'InternalSeniorPrepSnapshotResponse',
  ])('registers the %s visit-prep-checklist schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('VisitPrepChecklistResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['VisitPrepChecklistResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = ['booking', 'senior', 'memoryRecipes', 'generatedAt'];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('VisitPrepChecklistSenior surfaces operational fields only (no encrypted-payload fields)', () => {
    const schema = document.components?.schemas?.['VisitPrepChecklistSenior'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    // Operational fields ARE on the wire.
    for (const prop of [
      'seniorId',
      'dietaryTags',
      'allergenTags',
      'languageTags',
      'mobilityLevel',
      'dementiaStatus',
      'intakeCompletedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing operational property: ${prop}`).toBeDefined();
    }
    // Sensitive payload fields from senior-intake are deliberately
    // OMITTED from the TS-208 Phase-1 slice — they're gated on the
    // not-yet-existing senior-consent table (TS-062-followup-3) and
    // land via a follow-up.
    for (const prop of [
      'dateOfBirth',
      'dietaryNotes',
      'allergyNotes',
      'mobilityNotes',
      'medicalNotes',
    ]) {
      expect(
        schema?.properties?.[prop],
        `sensitive property must NOT be on the TS-208 prep wire: ${prop}`,
      ).toBeUndefined();
    }
  });

  // TS-211 — search ranking config schemas. Six schemas total: the
  // record + the upsert request/response + the get response (a
  // discriminated union with `found` / `not_found`) + the list response
  // + the delete response.
  it.each([
    'SearchRankingConfig',
    'UpsertSearchRankingConfigRequest',
    'UpsertSearchRankingConfigResponse',
    'GetSearchRankingConfigResponse',
    'ListSearchRankingConfigResponse',
    'DeleteSearchRankingConfigResponse',
  ])('registers the %s search-ranking-config schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('SearchRankingConfig carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['SearchRankingConfig'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    const expectedProps = [
      'id',
      'regionCode',
      'description',
      'tierWeightBasic',
      'tierWeightCertified',
      'tierWeightElite',
      'updatedByUserId',
      'createdAt',
      'updatedAt',
    ];
    for (const prop of expectedProps) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-215 — saved-search + favorite-provider schemas. The saved-search
  // surface has 7 schemas (record + create/update requests + list/get/run/
  // delete responses); the favorite-provider surface has 5 (record + create
  // request/response + list/delete responses).
  it.each([
    'SavedSearch',
    'CreateSavedSearchRequest',
    'UpdateSavedSearchRequest',
    'SavedSearchesListResponse',
    'GetSavedSearchResponse',
    'RunSavedSearchResponse',
    'DeleteSavedSearchResponse',
    'FavoriteProvider',
    'CreateFavoriteProviderRequest',
    'CreateFavoriteProviderResponse',
    'FavoriteProvidersListResponse',
    'DeleteFavoriteProviderResponse',
  ])(
    'registers the %s saved-search / favorite-provider schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('SavedSearch carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['SavedSearch'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'ownerUserId',
      'seniorId',
      'name',
      'query',
      'lastRunAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('FavoriteProvider carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FavoriteProvider'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['id', 'ownerUserId', 'providerId', 'seniorId', 'notes', 'createdAt']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-214 — "my seniors" directory schemas (status enum + per-senior
  // summary + list-response envelope).
  it.each(['MySeniorStatus', 'MySeniorSummary', 'MySeniorsResponse'])(
    'registers the %s my-seniors schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('MySeniorSummary carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['MySeniorSummary'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'householdId',
      'firstName',
      'lastName',
      'displayName',
      'status',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-238 — senior family-observability consent schemas (surface enum +
  // full-replace PUT request + response envelope with audit metadata).
  it.each(['SeniorConsentSurface', 'SetSeniorConsentRequest', 'SeniorConsentResponse'])(
    'registers the %s senior-consent schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('SeniorConsentResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['SeniorConsentResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'photos',
      'notes',
      'location',
      'health',
      'updatedAt',
      'updatedByUserId',
      'canManage',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-234 — per-(senior × family-member) alert-subscription schemas
  // (type enum + full-replace PUT request + response envelope).
  it.each([
    'SeniorAlertType',
    'SetSeniorAlertPreferencesRequest',
    'SeniorAlertPreferencesResponse',
  ])('registers the %s senior-alert-preferences schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('SeniorAlertPreferencesResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['SeniorAlertPreferencesResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'missedVisit',
      'concerningObservation',
      'emergencyFlag',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-232 — consent-gated senior photo-gallery schemas (item + query +
  // media-svc list response + gateway shared-flag response).
  it.each([
    'SeniorPhoto',
    'SeniorPhotoGalleryQuery',
    'SeniorPhotoGalleryResponse',
    'FamilySeniorPhotoGalleryResponse',
  ])('registers the %s senior-photos schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('FamilySeniorPhotoGalleryResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FamilySeniorPhotoGalleryResponse'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['seniorId', 'shared', 'photos', 'nextCursor']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-235 — monthly wellness-summary worker internal surfaces (household
  // batch + identity recipient-contacts + booking observation summary).
  it.each([
    'WellnessSummaryHousehold',
    'InternalWellnessSummaryHouseholdsResponse',
    'InternalRecipientContactsRequest',
    'InternalRecipientContactsResponse',
    'WellnessObservationMetricSummary',
    'InternalSeniorWellnessObservationSummaryResponse',
  ])('registers the %s wellness-summary schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('InternalSeniorWellnessObservationSummaryResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.[
      'InternalSeniorWellnessObservationSummaryResponse'
    ] as { properties?: Record<string, unknown>; required?: readonly string[] } | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'windowDays',
      'totalCompletedVisits',
      'metrics',
      'generatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-207 — featured-placement scheduling schemas (record + schedule
  // request/response + list response + delete response).
  it.each([
    'FeaturedPlacement',
    'ScheduleFeaturedPlacementRequest',
    'ScheduleFeaturedPlacementResponse',
    'FeaturedPlacementsListResponse',
    'DeleteFeaturedPlacementResponse',
  ])('registers the %s featured-placement schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('FeaturedPlacement carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FeaturedPlacement'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'providerId',
      'regionCode',
      'tier',
      'boostMultiplier',
      'startsAt',
      'endsAt',
      'note',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-213 — match-recommendation schemas (de-identified senior signal
  // profile + internal request/response + explainability signal +
  // scored recommendation + the gateway-keyed public response).
  it.each([
    'RecommendationSeniorProfile',
    'RecommendProvidersRequest',
    'RecommendationSignal',
    'RecommendedProvider',
    'RecommendProvidersResponse',
    'SeniorRecommendedProvidersResponse',
  ])('registers the %s recommendation schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('RecommendationSeniorProfile carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['RecommendationSeniorProfile'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['languages', 'dietaryTags', 'cuisinePreferences', 'dementiaSensitive']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('RecommendedProvider carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['RecommendedProvider'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['document', 'score', 'signals']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-222 — dedicated culinary-concierge assignment schemas (record +
  // create request/response + family snapshot + admin list + end response).
  it.each([
    'ConciergeAssignmentRecord',
    'CreateConciergeAssignmentRequest',
    'CreateConciergeAssignmentResponse',
    'ConciergeAssignmentSnapshotResponse',
    'ConciergeAssignmentsListResponse',
    'EndConciergeAssignmentResponse',
  ])('registers the %s concierge-assignment schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeAssignmentRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeAssignmentRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'primaryConciergeUserId',
      'primaryConciergeDisplayName',
      'backupConciergeUserId',
      'backupConciergeDisplayName',
      'status',
      'assignedByUserId',
      'startedAt',
      'endedAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-070-followup-2 — thread + thread-participant CRUD schemas.
  it.each([
    'ThreadParticipantRecord',
    'ThreadRecord',
    'ThreadWithParticipantsRecord',
    'CreateThreadRequest',
    'CreateThreadResponse',
    'ThreadsInboxResponse',
    'ThreadDetailResponse',
    'AddThreadParticipantRequest',
    'AddThreadParticipantResponse',
    'RemoveThreadParticipantResponse',
  ])('registers the %s messaging-thread schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ThreadWithParticipantsRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ThreadWithParticipantsRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'kind',
      'householdId',
      'bookingId',
      'createdAt',
      'updatedAt',
      'archivedAt',
      'participants',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-223 — concierge custom-request / service-request submission schemas.
  it.each([
    'ConciergeTicketRecord',
    'SubmitConciergeRequestRequest',
    'SubmitConciergeRequestResponse',
    'ConciergeTicketsListResponse',
  ])('registers the %s concierge-ticket schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeTicketRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeTicketRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'kind',
      'status',
      'subject',
      'body',
      'requestedDate',
      'partySize',
      'theme',
      'slaDueAt',
      'assignedToUserId',
      'escalationPath',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-224 — concierge ops-console schemas (note record + queue list + detail
  // + transition / escalate / add-note request+response).
  it.each([
    'ConciergeTicketNoteRecord',
    'ConciergeOpsTicketsListResponse',
    'ConciergeOpsTicketDetailResponse',
    'TransitionConciergeTicketRequest',
    'TransitionConciergeTicketResponse',
    'EscalateConciergeTicketRequest',
    'EscalateConciergeTicketResponse',
    'AddConciergeTicketNoteRequest',
    'AddConciergeTicketNoteResponse',
  ])('registers the %s concierge-ops schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeTicketNoteRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeTicketNoteRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['id', 'ticketId', 'authorUserId', 'body', 'createdAt']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-227 — concierge scheduled-event schemas (record + schedule
  // request/response + update request/response + list response).
  it.each([
    'ConciergeScheduledEventRecord',
    'ScheduleConciergeEventRequest',
    'ScheduleConciergeEventResponse',
    'UpdateConciergeEventRequest',
    'UpdateConciergeEventResponse',
    'ConciergeScheduledEventsListResponse',
  ])('registers the %s concierge scheduled-event schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeScheduledEventRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeScheduledEventRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'ticketId',
      'kind',
      'status',
      'title',
      'scheduledStart',
      'externalProvider',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-226 — concierge transportation schemas (record + schedule
  // request/response + update request/response + list response + the inbound
  // ride-status webhook event + response).
  it.each([
    'ConciergeTransportationRequestRecord',
    'ScheduleConciergeTransportationRequest',
    'ScheduleConciergeTransportationResponse',
    'UpdateConciergeTransportationRequest',
    'UpdateConciergeTransportationResponse',
    'ConciergeTransportationListResponse',
    'ConciergeRideStatusWebhookEvent',
    'ConciergeRideStatusWebhookResponse',
  ])('registers the %s concierge transportation schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeTransportationRequestRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeTransportationRequestRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'ticketId',
      'status',
      'externalProvider',
      'pickupAddress',
      'dropoffAddress',
      'scheduledPickupAt',
      'externalStatus',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-225 — emergency concierge-assistance schemas (trigger request +
  // response).
  it.each(['TriggerEmergencyAssistanceRequest', 'TriggerEmergencyAssistanceResponse'])(
    'registers the %s emergency schema under components.schemas',
    (name) => {
      expect(document.components?.schemas?.[name]).toBeDefined();
    },
  );

  it('TriggerEmergencyAssistanceRequest carries the category + note properties', () => {
    const schema = document.components?.schemas?.['TriggerEmergencyAssistanceRequest'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['category', 'note']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-228 — Tier-3 onboarding ("white-glove kickoff") schemas (step + record
  // + detail + create/get/list + update + update-step + family /me).
  it.each([
    'ConciergeOnboardingStepRecord',
    'ConciergeOnboardingRecord',
    'ConciergeOnboardingDetailRecord',
    'CreateConciergeOnboardingRequest',
    'CreateConciergeOnboardingResponse',
    'GetConciergeOnboardingResponse',
    'ConciergeOnboardingsListResponse',
    'UpdateConciergeOnboardingRequest',
    'UpdateConciergeOnboardingResponse',
    'UpdateConciergeOnboardingStepRequest',
    'UpdateConciergeOnboardingStepResponse',
    'MyConciergeOnboardingResponse',
  ])('registers the %s concierge onboarding schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('ConciergeOnboardingRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeOnboardingRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'status',
      'kickoffScheduledAt',
      'notes',
      'startedByUserId',
      'stepsTotal',
      'stepsCompleted',
      'completedAt',
      'canceledAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('ConciergeOnboardingDetailRecord carries the steps array property', () => {
    const schema = document.components?.schemas?.['ConciergeOnboardingDetailRecord'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    expect(schema?.properties?.['steps']).toBeDefined();
  });

  // TS-229 — Tier-3 weekly enrichment-summary schemas (record + create/get/list
  // + update + family list + family permalink).
  it.each([
    'ConciergeEnrichmentSummaryRecord',
    'CreateConciergeEnrichmentSummaryRequest',
    'CreateConciergeEnrichmentSummaryResponse',
    'GetConciergeEnrichmentSummaryResponse',
    'ConciergeEnrichmentSummariesListResponse',
    'UpdateConciergeEnrichmentSummaryRequest',
    'UpdateConciergeEnrichmentSummaryResponse',
    'MyConciergeEnrichmentSummariesResponse',
    'MyConciergeEnrichmentSummaryResponse',
  ])('registers the %s enrichment-summary schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  // TS-230 — family peace-of-mind dashboard schemas (query + visit-note
  // summary + past-visit + response envelope).
  it.each([
    'FamilyVisitsDashboardQuery',
    'DashboardVisitNoteSummary',
    'DashboardPastVisit',
    'FamilyVisitsDashboardResponse',
  ])('registers the %s dashboard schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('FamilyVisitsDashboardResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FamilyVisitsDashboardResponse'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'householdId',
      'seniorId',
      'windowDays',
      'upcoming',
      'history',
      'historyNextCursor',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-231 — wellness-trend schemas (query + point + series + service
  // response + family/gateway response with the consent `shared` flag).
  it.each([
    'WellnessTrendsQuery',
    'WellnessTrendPoint',
    'WellnessTrendSeries',
    'WellnessTrendsResponse',
    'FamilyWellnessTrendsResponse',
  ])('registers the %s wellness-trend schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('FamilyWellnessTrendsResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FamilyWellnessTrendsResponse'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'shared',
      'windowDays',
      'totalCompletedVisits',
      'series',
      'generatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-236 — wellness-anomaly schemas (severity + flag + service
  // response + family/gateway response with the consent `shared` flag).
  it.each([
    'WellnessAnomalySeverity',
    'WellnessAnomalyFlag',
    'WellnessAnomalyResponse',
    'FamilyWellnessAnomalyResponse',
  ])('registers the %s wellness-anomaly schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('FamilyWellnessAnomalyResponse carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['FamilyWellnessAnomalyResponse'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'seniorId',
      'shared',
      'windowDays',
      'totalCompletedVisits',
      'flags',
      'generatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  it('ConciergeEnrichmentSummaryRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['ConciergeEnrichmentSummaryRecord'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'householdId',
      'weekStartDate',
      'status',
      'headline',
      'visitHighlights',
      'wellnessSignals',
      'socialEngagement',
      'additionalNotes',
      'authoredByUserId',
      'publishedAt',
      'publishedByUserId',
      'archivedAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-271a — ad-campaign admin schemas (campaign record + detail + create /
  // update requests + creative-status request + list query + response
  // envelopes). The first service-ads schemas in the OpenAPI doc.
  it.each([
    'AdCampaignRecord',
    'CreateAdCampaignRequest',
    'UpdateAdCampaignRequest',
    'UpdateAdCreativeStatusRequest',
    'ListAdCampaignsQuery',
    'AdCampaignResponse',
    'AdCampaignDetailResponse',
    'AdCampaignsListResponse',
    'AdCreativeResponse',
  ])('registers the %s ads schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdCampaignRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdCampaignRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'name',
      'advertiserKind',
      'advertiserId',
      'status',
      'budgetMinor',
      'currency',
      'startAt',
      'endAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-272a — slot-inventory admin schemas (placement record + slot-schedule
  // record + create / update requests + list query + response envelopes).
  it.each([
    'AdPlacementRecord',
    'AdSlotScheduleRecord',
    'CreateAdSlotScheduleRequest',
    'UpdateAdSlotScheduleRequest',
    'ListAdSlotSchedulesQuery',
    'AdPlacementsListResponse',
    'AdSlotScheduleResponse',
    'AdSlotSchedulesListResponse',
  ])('registers the %s slot-inventory schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdSlotScheduleRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdSlotScheduleRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'placementId',
      'campaignId',
      'status',
      'priority',
      'startAt',
      'endAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-277 — creative approval-workflow + accessibility-check schemas (report +
  // review item / record + accessibility PATCH + review POST + queue query +
  // response envelopes).
  it.each([
    'AdAccessibilityReport',
    'AdCreativeReviewItem',
    'AdCreativeReviewRecord',
    'UpdateAdCreativeAccessibilityRequest',
    'ReviewAdCreativeRequest',
    'ListCreativeReviewQueueQuery',
    'CreativeReviewQueueResponse',
    'CreativeReviewDetailResponse',
    'CreativeReviewMutationResponse',
  ])('registers the %s creative-review schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AdCreativeReviewRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AdCreativeReviewRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'creativeId',
      'decision',
      'reviewerUserId',
      'notes',
      'accessibilityPassed',
      'overrodeAccessibility',
      'accessibility',
      'createdAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-251 — Cooking Academy course-catalog admin schemas (courses + modules
  // + lessons + cohorts: records + create/update requests + list queries +
  // response envelopes).
  it.each([
    'AcademyCourseRecord',
    'AcademyCourseDetail',
    'CreateAcademyCourseRequest',
    'UpdateAcademyCourseRequest',
    'ListAcademyCoursesQuery',
    'AcademyCourseResponse',
    'AcademyCourseDetailResponse',
    'AcademyCoursesListResponse',
    'AcademyCourseModuleRecord',
    'AcademyCourseModuleWithLessons',
    'CreateAcademyModuleRequest',
    'UpdateAcademyModuleRequest',
    'AcademyModuleResponse',
    'AcademyModulesListResponse',
    'DeleteAcademyModuleResponse',
    'AcademyLessonRecord',
    'CreateAcademyLessonRequest',
    'UpdateAcademyLessonRequest',
    'AcademyLessonResponse',
    'AcademyLessonsListResponse',
    'AcademyCohortRecord',
    'CreateAcademyCohortRequest',
    'UpdateAcademyCohortRequest',
    'ListAcademyCohortsQuery',
    'AcademyCohortResponse',
    'AcademyCohortsListResponse',
  ])('registers the %s academy schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('AcademyCourseRecord carries every required Zod field as an OpenAPI property', () => {
    const schema = document.components?.schemas?.['AcademyCourseRecord'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of [
      'id',
      'slug',
      'title',
      'summary',
      'kind',
      'track',
      'status',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
  });

  // TS-255 — Cooking Academy certification issuance + verification schemas.
  it.each([
    'IssueAcademyCertificationRequest',
    'RevokeAcademyCertificationRequest',
    'ListAcademyCertificationsQuery',
    'AcademyCertificationRecord',
    'AcademyCertificationResponse',
    'AcademyCertificationsListResponse',
    'PublicCertificationVerification',
    'PublicCertificationVerificationResponse',
  ])('registers the %s certification schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('PublicCertificationVerification does NOT leak the studentUserId or PDF key', () => {
    const schema = document.components?.schemas?.['PublicCertificationVerification'] as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(schema).toBeDefined();
    for (const prop of ['holderName', 'courseTitle', 'track', 'status', 'valid', 'issuedAt']) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
    for (const leaked of [
      'studentUserId',
      'certificatePdfKey',
      'enrollmentId',
      'id',
      'verificationToken',
    ]) {
      expect(schema?.properties?.[leaked], `must not expose: ${leaked}`).toBeUndefined();
    }
  });

  // TS-256 — certification-renewal worker internal surfaces.
  it.each([
    'CertificationRenewalCandidate',
    'InternalCertificationRenewalsResponse',
    'InternalCertificationRenewalsQuery',
    'ExpireCertificationResponse',
  ])('registers the %s renewal schema under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('CertificationRenewalCandidate carries only the worker-needed fields', () => {
    const schema = document.components?.schemas?.['CertificationRenewalCandidate'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(schema).toBeDefined();
    for (const prop of [
      'certificationId',
      'studentUserId',
      'holderName',
      'courseId',
      'courseTitle',
      'track',
      'issuedAt',
      'expiresAt',
    ]) {
      expect(schema?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
    for (const omitted of ['verificationToken', 'certificatePdfKey', 'enrollmentId']) {
      expect(schema?.properties?.[omitted], `must not expose: ${omitted}`).toBeUndefined();
    }
  });
});

/**
 * Privacy Center registration (TS-309b1-followup-1).
 *
 * The document is where a consumer learns which of the two request views it
 * is holding, so the property worth pinning is not "these keys exist" but
 * "the receipt is narrower than the record, in exactly the fields that decide
 * disclosure".
 */
describe('generateOpenApiDocument — Privacy Center (TS-309a / TS-309b1)', () => {
  it.each([
    'DataSubjectRequestKind',
    'DataSubjectKind',
    'DataSubjectRequestStatus',
    'DataSubjectRequestRefusalReason',
    'CreateDataSubjectRequest',
    'DataSubjectRequestReceipt',
    'DataSubjectRequestReceiptResponse',
    'DataSubjectRequestListResponse',
    'DataSubjectRequestRecord',
    'DataSubjectRequestResponse',
    'AdminDataSubjectRequestListResponse',
    'ListDataSubjectRequestsQuery',
    'VerifyDataSubjectRequest',
    'RefuseDataSubjectRequest',
    'ExtendDataSubjectRequest',
    'PrivacyExportSection',
    'PrivacyExportWithholding',
    'PrivacyExportSlice',
    'PrivacyExportSliceParams',
  ])('registers %s under components.schemas', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('the requester receipt withholds what the operator record carries', () => {
    const receipt = document.components?.schemas?.['DataSubjectRequestReceipt'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(receipt).toBeDefined();

    for (const prop of [
      'id',
      'kind',
      'subjectKind',
      'status',
      'selfService',
      'receivedAt',
      'dueAt',
    ]) {
      expect(receipt?.properties?.[prop], `missing property: ${prop}`).toBeDefined();
    }
    // The three that decide disclosure. A receipt carrying any of them is an
    // over-disclosure, and the gateway 502s on exactly this drift.
    for (const omitted of [
      'verificationMethod',
      'verifiedByUserId',
      'refusalNote',
      'note',
      'requesterUserId',
    ]) {
      expect(receipt?.properties?.[omitted], `receipt must not expose: ${omitted}`).toBeUndefined();
    }
  });

  it('the create request cannot name its own requester', () => {
    const create = document.components?.schemas?.['CreateDataSubjectRequest'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(create?.properties?.['kind']).toBeDefined();
    expect(create?.properties?.['requesterUserId']).toBeUndefined();
  });

  it('the export slice publishes all three outcomes as a union', () => {
    const slice = document.components?.schemas?.['PrivacyExportSlice'] as
      | { oneOf?: readonly unknown[]; anyOf?: readonly unknown[] }
      | undefined;
    expect(slice).toBeDefined();
    const branches = slice?.oneOf ?? slice?.anyOf;
    expect(branches).toHaveLength(3);
  });
});

describe('generateOpenApiDocument — provider review surfaces (TS-305a / TS-305b / TS-305d)', () => {
  /**
   * These three surfaces were published for weeks with no OpenAPI entry
   * at all — which is precisely why a contract change to the dossier
   * needed no `generated/openapi.json` regeneration and nobody noticed
   * (TS-305d-followup-4). This block is the guard against that
   * recurring.
   *
   * It reuses the file's module-level `document`: a locally generated
   * one types as `unknown`.
   */
  it.each([
    'ProviderDossierCore',
    'ProviderDossierBackgroundCheck',
    'ProviderDossierResponse',
    'ProviderMetricsCounts',
    'ProviderMetricsWindow',
    'ProviderMetricsSection',
    'Provider360IncidentsSection',
    'Provider360Response',
  ])('registers %s', (name) => {
    expect(document.components?.schemas?.[name]).toBeDefined();
  });

  it('publishes the metrics window as a three-branch union — the whole point is that a state is not a score', () => {
    const window = document.components?.schemas?.['ProviderMetricsWindow'] as
      | { oneOf?: readonly unknown[]; anyOf?: readonly unknown[] }
      | undefined;
    expect(window).toBeDefined();
    const branches = window?.oneOf ?? window?.anyOf;
    expect(branches).toHaveLength(3);
  });

  it('publishes NO rating field on the metrics section — its absence is the contract (TS-305e)', () => {
    const section = document.components?.schemas?.['ProviderMetricsSection'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(section?.properties?.['lifetime']).toBeDefined();
    for (const absent of ['rating', 'ratingAvg', 'ratingCount', 'reviews']) {
      expect(section?.properties?.[absent], `must not publish: ${absent}`).toBeUndefined();
    }
  });

  it('publishes the counts under names that do not claim attribution the platform cannot establish', () => {
    const counts = document.components?.schemas?.['ProviderMetricsCounts'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(counts?.properties?.['bookingsCanceledAfterAcceptance']).toBeDefined();
    for (const absent of [
      'cancellationsCaused',
      'providerFaultCancellations',
      'canceledByUserId',
    ]) {
      expect(counts?.properties?.[absent], `must not publish: ${absent}`).toBeUndefined();
    }
  });

  it('carries windowDays on the section, so a consumer never has to assume the window', () => {
    const section = document.components?.schemas?.['ProviderMetricsSection'] as
      | { properties?: Record<string, unknown>; required?: readonly string[] }
      | undefined;
    expect(section?.properties?.['windowDays']).toBeDefined();
    expect(section?.required).toContain('windowDays');
  });

  it('publishes the 360 incident section as a degradable union while metrics is a plain pass-through', () => {
    const incidents = document.components?.schemas?.['Provider360IncidentsSection'] as
      | { oneOf?: readonly unknown[]; anyOf?: readonly unknown[] }
      | undefined;
    expect(incidents?.oneOf ?? incidents?.anyOf).toBeDefined();

    // metrics has no `unavailable` state of its own: it rides the
    // dossier, which is the FATAL upstream.
    const section = document.components?.schemas?.['ProviderMetricsSection'] as
      | { oneOf?: readonly unknown[]; anyOf?: readonly unknown[] }
      | undefined;
    expect(section?.oneOf ?? section?.anyOf).toBeUndefined();
  });
});
