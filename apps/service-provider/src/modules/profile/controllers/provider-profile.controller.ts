import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ProviderProfileRecordSchema,
  UpdateProviderProfileRequestSchema,
  UpdateProviderProfileResponseSchema,
  type ProviderProfileRecord,
  type UpdateProviderProfileRequest,
  type UpdateProviderProfileResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import {
  ProviderProfileService,
  type ProviderProfileFailure,
  type ProviderProfileSnapshot,
} from '../services/provider-profile.service';

/**
 * Provider profile HTTP boundary (TS-200).
 *
 * Endpoints:
 *
 *   GET /api/v1/providers/me/profile-snapshot
 *     Returns the authenticated user's provider profile in the
 *     `ProviderProfileRecord` shape (the richer projection that
 *     carries the tag arrays + dementia-sensitive flag). Powers the
 *     web-provider editor's initial-render fetch. Returns
 *     `{ profile: null }` when the authenticated user has no
 *     provider row (they haven't completed the application yet).
 *
 *   GET /api/v1/providers/:providerId/profile  (TS-200-followup-4)
 *     Returns the bare `ProviderProfileRecord` for the given
 *     provider id; 404 on missing or soft-deleted. The deliberately-
 *     different shape from the `me/profile-snapshot` wrapper above —
 *     the snapshot encodes "no application yet" as
 *     `{ profile: null }` because the editor needs to render an
 *     empty-state placeholder; the by-id surface treats missing as
 *     404 because consumers (admin tooling TS-127, booking-detail
 *     TS-128) have a concrete provider id in hand and a missing row
 *     is a hard error. Any authenticated caller may read — there's
 *     no row-level ownership gate (PRD §6.3 frames the detailed
 *     profile as the family-portal browse experience). Soft-deleted
 *     rows (`deleted_at != null`) are returned as 404 so the
 *     archived state is invisible to consumers.
 *
 *   PUT /api/v1/providers/:providerId/profile
 *     Self-service profile update — bio, language / cuisine /
 *     dietary-expertise tag sets, and the dementia-sensitive flag.
 *     The caller must own the provider row (the authenticated user's
 *     id must match `providers.user_id`). Admin override lands as
 *     TS-200-followup-1 once `PermissionGuard` lifts to the shared
 *     `packages/nest-auth` per TS-052-followup-11.
 *
 *     Status codes:
 *       200 OK            — body is the UpdateProviderProfileResponse.
 *       400 Bad Request   — payload failed Zod validation.
 *       401 Unauthorized  — missing / invalid access token.
 *       403 Forbidden     — provider exists but the actor doesn't
 *                           own the row.
 *       404 Not Found     — provider doesn't exist (or has been
 *                           soft-deleted, which we treat as gone
 *                           from the self-service perspective).
 *       412 Precondition Failed — `If-Match` was set but the row's
 *                           `updated_at` no longer matches (another
 *                           tab / admin edit happened first). Body
 *                           carries `currentUpdatedAt` so the client
 *                           knows where the truth has drifted to.
 *
 * Optimistic concurrency (TS-200-followup-5). Clients may set
 * `If-Match: "<updatedAt>"` (RFC 7232 quoted-string form) or
 * `If-Match: <updatedAt>` (unquoted, lenient form) on the PUT.
 * `If-Match: *` matches any existing row and is treated as "skip
 * the precondition" — the caller still wins ownership + 404 checks
 * but the freshness compare is bypassed. Header absent → no
 * precondition check (backward-compat for pre-TS-200-followup-5
 * clients).
 *
 * Idempotency. The PUT wears `@Idempotent()` so a retried request
 * with the same `Idempotency-Key` returns the cached response. The
 * shared SDK swallows transient client retries (browser refresh,
 * mobile flaky network) without re-running the transaction.
 *
 * No POST / DELETE today:
 *   - DELETE — never; the profile is part of the provider row
 *     lifecycle. Soft-delete the provider (status=archived) to take
 *     the profile out of circulation.
 *   - POST (create) — covered by the application-submit flow
 *     (TS-051); the profile row is created at application time and
 *     edited via this PUT thereafter.
 */
/**
 * Wrapper response for the `me/profile-snapshot` endpoint —
 * `{ profile: null }` when the authenticated user has no provider
 * row yet (pre-application users); `{ profile: ProviderProfileRecord }`
 * otherwise. Inlined here rather than promoted to the contracts
 * package because this surface is specifically the editor's
 * initial-render shape and the sibling `:providerId/profile` by-id
 * endpoint wraps the same `ProviderProfileRecord` differently (the
 * by-id surface returns the bare record, since 404 fires for a
 * missing row).
 */
interface ProfileSnapshotResponse {
  readonly profile: ProviderProfileRecord | null;
}

@Controller()
export class ProviderProfileController {
  constructor(private readonly profile: ProviderProfileService) {}

  @Get('api/v1/providers/me/profile-snapshot')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMySnapshot(@Req() request: RequestWithContext): Promise<ProfileSnapshotResponse> {
    const actorUserId = requireActorUserId(request);
    const snapshot = await this.profile.getProfileByUserId(actorUserId);
    if (snapshot === null) {
      return { profile: null };
    }
    return { profile: toProfileDto(snapshot) };
  }

  @Get('api/v1/providers/:providerId/profile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getProfileById(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<ProviderProfileRecord> {
    // 401 if the access-token guard didn't seed a request context —
    // defence-in-depth (the guard rejects before this runs).
    requireActorUserId(request);
    const snapshot = await this.profile.getProfile(providerId);
    if (snapshot === null || snapshot.row.deletedAt !== null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    }
    return toProfileDto(snapshot);
  }

  @Put('api/v1/providers/:providerId/profile')
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async updateProfile(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(UpdateProviderProfileRequestSchema))
    body: UpdateProviderProfileRequest,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderProfileResponse> {
    const actorUserId = requireActorUserId(request);

    const ifMatch = parseIfMatchHeader(ifMatchHeader);
    if (ifMatch.kind === 'invalid') {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail:
          "If-Match must be the snapshot's ISO-8601 updatedAt value (optionally quoted) or `*`.",
      });
    }

    const result = await this.profile.updateProfile({
      providerId,
      actorUserId,
      bio: body.bio,
      languages: body.languages,
      cuisines: body.cuisines,
      dietaryExpertise: body.dietaryExpertise,
      dementiaSensitive: body.dementiaSensitive,
      ...(ifMatch.kind === 'precondition' && { ifMatchUpdatedAt: ifMatch.value }),
    });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: UpdateProviderProfileResponse = {
      profile: toProfileDto(result.value),
    };
    // Defence-in-depth: validate the response shape at the boundary
    // so a future drift between service projection + contract surfaces
    // at the controller rather than at the consumer.
    return UpdateProviderProfileResponseSchema.parse(response);
  }
}

/**
 * Result of parsing the `If-Match` HTTP header on the PUT surface.
 *   - `absent` — caller did not send the header; service skips the
 *     precondition (backward-compat).
 *   - `wildcard` — caller sent `If-Match: *`; semantically "must
 *     exist" which is already true here (404 fires first); service
 *     skips the freshness compare.
 *   - `precondition` — caller sent a parsable ISO datetime; service
 *     compares against the row's `updated_at`.
 *   - `invalid` — caller sent a non-empty, non-`*`, non-ISO value;
 *     controller throws 400 rather than passing junk through.
 */
type ParsedIfMatch =
  | { readonly kind: 'absent' }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'precondition'; readonly value: Date }
  | { readonly kind: 'invalid' };

function parseIfMatchHeader(header: string | undefined): ParsedIfMatch {
  if (header === undefined) return { kind: 'absent' };
  const trimmed = header.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed === '*') return { kind: 'wildcard' };
  // Strip a single pair of surrounding double-quotes (the RFC 7232
  // quoted-string form). We deliberately tolerate the unquoted form
  // too — internal API consumers shouldn't have to know about ETag
  // ceremony. The optional `W/` weak-validator prefix is rejected
  // outright (we don't issue weak ETags, accepting them would be
  // misleading).
  if (trimmed.startsWith('W/')) return { kind: 'invalid' };
  let raw = trimmed;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    raw = raw.slice(1, -1);
  }
  // Reject anything that doesn't round-trip through Date — guards
  // against `null` / `undefined` / random strings parsing as NaN.
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { kind: 'invalid' };
  return { kind: 'precondition', value: new Date(ms) };
}

function requireActorUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function throwFailure(failure: ProviderProfileFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    case 'forbidden':
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You may only edit your own provider profile.',
      });
    case 'precondition_failed':
      // TS-200-followup-5: 412 carries `currentUpdatedAt` in the body
      // so the client can decide between "refresh and retry" and
      // "show the user the divergence". The HTTP `ETag` response
      // header is intentionally NOT set here — we already encode the
      // server-truth in the body, and Nest's exception flow doesn't
      // give us a clean way to set response headers on a throw.
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Precondition Failed',
          status: 412,
          detail: 'The profile has been updated since you loaded it. Refresh and try again.',
          currentUpdatedAt: failure.currentUpdatedAt.toISOString(),
        },
        HttpStatus.PRECONDITION_FAILED,
      );
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Profile update failed at the event-emission stage. Please retry.',
      });
  }
}

function toProfileDto(snapshot: ProviderProfileSnapshot): ProviderProfileRecord {
  const dto: ProviderProfileRecord = {
    id: snapshot.row.id,
    status: snapshot.row.status,
    tier: snapshot.row.tier,
    displayName: snapshot.row.displayName,
    headline: snapshot.row.headline,
    bio: snapshot.row.bio,
    profilePhotoKey: snapshot.row.profilePhotoKey,
    videoIntroKey: snapshot.row.videoIntroKey,
    timeZone: snapshot.row.timeZone,
    dementiaSensitive: snapshot.row.dementiaSensitive,
    languages: [...snapshot.languages],
    cuisines: [...snapshot.cuisines],
    dietaryExpertise: [...snapshot.dietaryExpertise],
    createdAt: snapshot.row.createdAt.toISOString(),
    updatedAt: snapshot.row.updatedAt.toISOString(),
  };
  // Parse-validate at projection time so a Prisma row shape drift
  // surfaces as a 500 (with stack trace) rather than as a silent
  // contract mismatch on the consumer side.
  return ProviderProfileRecordSchema.parse(dto);
}
