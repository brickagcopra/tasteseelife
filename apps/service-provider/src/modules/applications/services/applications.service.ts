import { Injectable, Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';

import { PrismaService } from '../../../prisma/prisma.service';

import {
  ApplicationsMetrics,
  submitApplicationOutcome,
  type ProviderApplicationSubmitOutcome,
} from './applications-metrics';
import {
  BackgroundCheckService,
  type BackgroundCheckRecord,
  type BackgroundCheckServiceFailure,
} from './background-check.service';
import type { CreateCandidateInput } from './checkr.client';
import { err, ok, type Result } from './result';

/**
 * Local mirrors of the Prisma-generated enums + row shapes. Same
 * TS-021-followup-2 / TS-021-followup-3 root cause documented in
 * `kyc.service.ts`. The contract-side schemas in `packages/contracts`
 * cross-pin the network-facing shape.
 */
export type ProviderStatus = 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
export type ProviderTier = 'basic' | 'certified' | 'elite';
export type ApplicationStatus = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'withdrawn';

export interface ProviderRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: ProviderStatus;
  readonly tier: ProviderTier;
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface ApplicationRecord {
  readonly id: string;
  readonly providerId: string;
  readonly status: ApplicationStatus;
  readonly applicantNotes: string | null;
  readonly reviewerUserId: string | null;
  readonly reviewNotes: string | null;
  readonly submittedAt: Date;
  readonly reviewedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Profile fields lifted onto the `providers` row at submission time.
 * Captured separately from `CreateCandidateInput` because applicant
 * PII (legal name, DOB, SSN, address) flows directly to Checkr and
 * is never persisted, whereas profile shape lives on the providers
 * row indefinitely.
 */
export interface SubmitApplicationProfileInput {
  readonly displayName: string;
  readonly timeZone: string;
  readonly headline?: string;
  readonly bio?: string;
}

export interface SubmitApplicationInput {
  readonly userId: string;
  readonly profile: SubmitApplicationProfileInput;
  readonly applicant: CreateCandidateInput;
  readonly applicantNotes?: string;
  readonly idempotencyKey?: string;
}

export interface SubmitApplicationResult {
  readonly provider: ProviderRecord;
  readonly application: ApplicationRecord;
  readonly backgroundCheck: BackgroundCheckRecord;
}

export interface GetLatestForUserResult {
  readonly provider: ProviderRecord | null;
  readonly application: ApplicationRecord | null;
  readonly backgroundCheck: BackgroundCheckRecord | null;
}

/**
 * Failure shapes returned by `ApplicationsService.submitApplication`.
 */
export type ApplicationsServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'already_applied'; readonly applicationId: string }
  | BackgroundCheckServiceFailure;

/**
 * `ApplicationsService` — orchestrates the provider application
 * lifecycle (TS-051).
 *
 * Two surfaces:
 *
 *   1. `submitApplication({ userId, profile, applicant })` —
 *      idempotent at the user level (one active application per
 *      provider; submitting again while an existing application is
 *      `submitted` / `in_review` returns the existing one with a
 *      typed `already_applied` error). Behind the scenes:
 *        - Upserts the `providers` row from the supplied profile.
 *          The transition `pending` → `in_review` is the provider's
 *          state-machine move when an application is opened.
 *        - Inserts a `provider_applications` row in `submitted`.
 *        - Calls `BackgroundCheckService.startCheck` which posts to
 *          Checkr and persists the `provider_background_checks`
 *          row.
 *
 *   2. `getLatestForUser(userId)` — returns the provider row + the
 *      most-recent application + the most-recent background check
 *      for the authenticated user. Each field is null when nothing
 *      exists (a user who has never applied gets `null/null/null`).
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Each call resolves the
 * authenticated `userId` to a provider row server-side; the
 * controller never passes a `providerId` directly. TS-141's Prisma
 * extension will move the enforcement down a layer.
 *
 * **Outbox-ready**. When TS-142 lands, `submitApplication` emits a
 * `provider.application_submitted` event transactionally with the
 * insert; consumers (notification-svc, audit-svc) subscribe via the
 * outbox relay (captured as TS-051-followup-N).
 */
@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backgroundCheck: BackgroundCheckService,
    // Optional default (TS-051-followup-7) — the two-arg unit-test call
    // sites keep working; Nest injects the registered provider in prod.
    // No-op meter until `initMetrics` runs (KycMetrics precedent).
    private readonly metrics: ApplicationsMetrics = new ApplicationsMetrics(),
  ) {}

  async submitApplication(
    input: SubmitApplicationInput,
  ): Promise<Result<SubmitApplicationResult, ApplicationsServiceFailure>> {
    return withSpan('provider.application.submit', async (span) => {
      // Default to `error` so an unexpected throw records a bounded
      // outcome rather than mislabelling the sample.
      let outcome: ProviderApplicationSubmitOutcome = 'error';
      try {
        const result = await this.runSubmitApplication(input);
        outcome = result.ok ? 'ok' : submitApplicationOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('provider.application.outcome', outcome);
        this.metrics.recordSubmitted(outcome);
      }
    });
  }

  private async runSubmitApplication(
    input: SubmitApplicationInput,
  ): Promise<Result<SubmitApplicationResult, ApplicationsServiceFailure>> {
    if (input.userId.length === 0) {
      return err({ reason: 'invalid_request', message: 'userId is required' });
    }
    if (input.profile.displayName.length === 0) {
      return err({ reason: 'invalid_request', message: 'profile.displayName is required' });
    }
    if (input.profile.timeZone.length === 0) {
      return err({ reason: 'invalid_request', message: 'profile.timeZone is required' });
    }

    // 1. Upsert the provider row from the profile shape. The
    //    `userId @unique` invariant on `providers` means a second
    //    `submitApplication` from the same user resolves to the
    //    same provider row.
    const existing = (await this.prisma.provider.findUnique({
      where: { userId: input.userId },
    })) as ProviderRecord | null;

    // 2. Bail early if the user already has an active (non-terminal)
    //    application. The portal surfaces "you've already applied"
    //    UX in that case.
    if (existing !== null) {
      const activeApplication = (await this.prisma.providerApplication.findFirst({
        where: {
          providerId: existing.id,
          status: { in: ['submitted', 'in_review'] },
        },
        orderBy: { submittedAt: 'desc' },
      })) as ApplicationRecord | null;
      if (activeApplication !== null) {
        return err({ reason: 'already_applied', applicationId: activeApplication.id });
      }
    }

    const provider: ProviderRecord =
      existing === null
        ? ((await this.prisma.provider.create({
            data: {
              userId: input.userId,
              status: 'in_review',
              displayName: input.profile.displayName,
              timeZone: input.profile.timeZone,
              ...(input.profile.headline !== undefined && { headline: input.profile.headline }),
              ...(input.profile.bio !== undefined && { bio: input.profile.bio }),
            },
          })) as ProviderRecord)
        : ((await this.prisma.provider.update({
            where: { id: existing.id },
            data: {
              status: 'in_review',
              displayName: input.profile.displayName,
              timeZone: input.profile.timeZone,
              ...(input.profile.headline !== undefined && { headline: input.profile.headline }),
              ...(input.profile.bio !== undefined && { bio: input.profile.bio }),
            },
          })) as ProviderRecord);

    // 3. Insert the new application row.
    const application = (await this.prisma.providerApplication.create({
      data: {
        providerId: provider.id,
        status: 'submitted',
        ...(input.applicantNotes !== undefined && { applicantNotes: input.applicantNotes }),
      },
    })) as ApplicationRecord;

    // 4. Kick off the Checkr background check. Forward the
    //    idempotencyKey so a retry of submitApplication does not
    //    create duplicate Checkr resources.
    const checkResult = await this.backgroundCheck.startCheck({
      providerId: provider.id,
      applicationId: application.id,
      applicant: input.applicant,
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
    });
    if (!checkResult.ok) {
      // Leave the provider row + application row in place — admin
      // tooling (TS-127) can re-trigger the check, and the family-
      // facing UX is "your application is on file; we'll re-run the
      // check shortly". Returning the typed failure lets the
      // controller surface 503 (checkr_unavailable) or 400
      // (invalid_applicant).
      this.logger.warn(
        {
          userId: input.userId,
          providerId: provider.id,
          applicationId: application.id,
          reason: checkResult.error.reason,
        },
        'application.submit: backgroundCheck.start failed',
      );
      return err(checkResult.error);
    }

    this.logger.log(
      {
        userId: input.userId,
        providerId: provider.id,
        applicationId: application.id,
        backgroundCheckId: checkResult.value.id,
      },
      'application.submit ok',
    );
    return ok({
      provider,
      application,
      backgroundCheck: checkResult.value,
    });
  }

  async getLatestForUser(userId: string): Promise<GetLatestForUserResult> {
    if (userId.length === 0) {
      return { provider: null, application: null, backgroundCheck: null };
    }
    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
    })) as ProviderRecord | null;
    if (provider === null) {
      return { provider: null, application: null, backgroundCheck: null };
    }
    const application = (await this.prisma.providerApplication.findFirst({
      where: { providerId: provider.id },
      orderBy: { submittedAt: 'desc' },
    })) as ApplicationRecord | null;
    const backgroundCheck = await this.backgroundCheck.getLatestForProvider(provider.id);
    return { provider, application, backgroundCheck };
  }
}
