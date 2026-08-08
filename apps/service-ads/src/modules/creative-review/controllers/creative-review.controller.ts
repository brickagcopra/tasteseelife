import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  CreativeReviewDetailResponseSchema,
  CreativeReviewMutationResponseSchema,
  CreativeReviewQueueResponseSchema,
  ListCreativeReviewQueueQuerySchema,
  ReviewAdCreativeRequestSchema,
  UpdateAdCreativeAccessibilityRequestSchema,
  type CreativeReviewDetailResponse,
  type CreativeReviewMutationResponse,
  type CreativeReviewQueueResponse,
  type ListCreativeReviewQueueQuery,
  type ReviewAdCreativeRequest,
  type UpdateAdCreativeAccessibilityRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { CreativeReviewService } from '../services/creative-review.service';

/**
 * Creative approval-workflow HTTP boundary (TS-277; PRD §10.9; PDD §18.3).
 *
 *   GET   /api/v1/admin/ads/creatives/review-queue              — pending queue.   `marketing:approve_creative`.
 *   GET   /api/v1/admin/ads/creatives/:creativeId/review        — review detail.   `marketing:approve_creative`.
 *   PATCH /api/v1/admin/ads/creatives/:creativeId/accessibility — a11y metadata.   `ads:write`.
 *   POST  /api/v1/admin/ads/creatives/:creativeId/review        — decision.        `marketing:approve_creative`.
 *
 * **Authorisation — two trust tiers (PDD Appendix B).** The review surface (queue,
 * detail, decision) is gated on `marketing:approve_creative` — a SEPARATE,
 * higher-trust gate than `ads:write` so the campaign author cannot self-approve
 * their own creative. The accessibility-metadata edit is the author's `ads:write`.
 * Every endpoint sits behind `AccessTokenGuard` then `PermissionGuard`
 * (`@RequirePermissions(...)`, CLAUDE.md §3.2); the gateway BFF (TS-277b)
 * enforces the same gate at the edge (defence-in-depth).
 *
 * **Idempotency.** The two write endpoints wear `@Idempotent()`.
 *
 * **Actor attribution.** The acting admin's id is the authoritative `userId`
 * from the verified token — never read from the body.
 */
@Controller()
export class CreativeReviewController {
  constructor(private readonly reviews: CreativeReviewService) {}

  @Get('api/v1/admin/ads/creatives/review-queue')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async queue(
    @Query(new ZodValidationPipe(ListCreativeReviewQueueQuerySchema))
    query: ListCreativeReviewQueueQuery,
  ): Promise<CreativeReviewQueueResponse> {
    const items = await this.reviews.getReviewQueue(query.limit);
    return CreativeReviewQueueResponseSchema.parse({ items: [...items] });
  }

  @Get('api/v1/admin/ads/creatives/:creativeId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('creativeId') creativeId: string): Promise<CreativeReviewDetailResponse> {
    const outcome = await this.reviews.getReviewDetail(creativeId);
    if (!outcome.ok) throw creativeNotFound(creativeId);
    return CreativeReviewDetailResponseSchema.parse({
      item: outcome.item,
      reviews: [...outcome.reviews],
    });
  }

  @Patch('api/v1/admin/ads/creatives/:creativeId/accessibility')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateAccessibility(
    @Param('creativeId') creativeId: string,
    @Body(new ZodValidationPipe(UpdateAdCreativeAccessibilityRequestSchema))
    body: UpdateAdCreativeAccessibilityRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewMutationResponse> {
    const ctx = requireContext(request);
    const outcome = await this.reviews.updateAccessibility({
      ...body,
      creativeId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw creativeNotFound(creativeId);
    return CreativeReviewMutationResponseSchema.parse({ item: outcome.item, review: null });
  }

  @Post('api/v1/admin/ads/creatives/:creativeId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async review(
    @Param('creativeId') creativeId: string,
    @Body(new ZodValidationPipe(ReviewAdCreativeRequestSchema))
    body: ReviewAdCreativeRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewMutationResponse> {
    const ctx = requireContext(request);
    const outcome = await this.reviews.reviewCreative({
      creativeId,
      action: body.action,
      notes: body.notes,
      acknowledgeAccessibilityFailures: body.acknowledgeAccessibilityFailures,
      reviewerUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          throw creativeNotFound(creativeId);
        case 'not_in_review':
          throw conflict(
            `Creative '${creativeId}' is '${outcome.status}', not 'pending_review' — it cannot be reviewed.`,
          );
        case 'accessibility_failed': {
          const failed = outcome.report.checks
            .filter((c) => c.status === 'fail')
            .map((c) => c.id)
            .join(', ');
          throw unprocessable(
            `Accessibility checks failed (${failed}). Resubmit with acknowledgeAccessibilityFailures=true and notes to approve as an audited override.`,
          );
        }
        case 'override_reason_required':
          throw unprocessable(
            'notes is required to approve a creative whose accessibility report fails (the override justification).',
          );
      }
    }
    return CreativeReviewMutationResponseSchema.parse({
      item: outcome.item,
      review: outcome.review,
    });
  }
}

function creativeNotFound(creativeId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No creative found for id '${creativeId}'.`,
  });
}

function conflict(detail: string): ConflictException {
  return new ConflictException({
    type: 'about:blank',
    title: 'Conflict',
    status: HttpStatus.CONFLICT,
    detail,
  });
}

function unprocessable(detail: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: 'about:blank',
    title: 'Unprocessable Entity',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    detail,
  });
}

function requireContext(request: RequestWithContext): RequestContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}
