import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  CONCIERGE_ASSIGNMENT_ID_MAX_LENGTH,
  ConciergeAssignmentSnapshotResponseSchema,
  ConciergeAssignmentsListResponseSchema,
  CreateConciergeAssignmentRequestSchema,
  CreateConciergeAssignmentResponseSchema,
  EndConciergeAssignmentResponseSchema,
  HOUSEHOLD_SCOPE_HEADER,
  ListConciergeAssignmentsQuerySchema,
  type ConciergeAssignmentSnapshotResponse,
  type ConciergeAssignmentsListResponse,
  type CreateConciergeAssignmentRequest,
  type CreateConciergeAssignmentResponse,
  type EndConciergeAssignmentResponse,
  type ListConciergeAssignmentsQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import { z } from 'zod';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { AssignmentsService } from '../services/assignments.service';

/** Path-param validator — bounds the id so a malformed value can't dodge the index lookup. */
const AssignmentIdSchema = z.string().min(1).max(CONCIERGE_ASSIGNMENT_ID_MAX_LENGTH);

/**
 * Dedicated culinary-concierge assignment HTTP boundary (TS-222; PRD §5.1
 * Tier 3 "Dedicated culinary concierge", §6.6; PDD §10.6).
 *
 * Admin surfaces (behind `AccessTokenGuard` + `SuperAdminRoleGuard` — the
 * api-gateway enforces the same gate at the edge; this is defence-in-depth
 * for a caller that bypasses the gateway):
 *
 *   POST   /api/v1/concierge/assignments
 *     Assign (or replace) the household's dedicated concierge. Ends any
 *     prior active assignment and inserts a fresh active row. The
 *     attributing admin is taken from the authenticated request context
 *     (`ctx.userId`), never from the body — the body's optional
 *     `assignedByUserId` exists for the gateway-stamping convention but
 *     the authenticated actor is authoritative here. 201 + the created
 *     row; 409 on the rare single-active create/create race.
 *
 *   GET    /api/v1/concierge/assignments?householdId=…
 *     The household's assignment history, active-first then by recency.
 *
 *   DELETE /api/v1/concierge/assignments/:assignmentId
 *     End the active assignment without a replacement (e.g. a household
 *     downgrades out of Tier 3). Idempotent.
 *
 * Family surface (behind `AccessTokenGuard` only):
 *
 *   GET    /api/v1/concierge/assignments/me
 *     The active assignment for the actor's household, resolved from the
 *     token's `tenantScope: {type:'household', householdId}` claim. No
 *     household id crosses the wire — the token is the household-membership
 *     trust boundary (service-concierge cannot read
 *     `household.household_members`, CLAUDE.md §2.3). Returns
 *     `{ householdId, assignment: null }` when the household has no
 *     dedicated concierge.
 *
 * Idempotency. The mutating endpoints (POST + DELETE) wear `@Idempotent()`
 * so a retried request with the same `Idempotency-Key` returns the cached
 * response (CLAUDE.md §3.3 / §17.5).
 */
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Post('api/v1/concierge/assignments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  @UsePipes(new ZodValidationPipe(CreateConciergeAssignmentRequestSchema))
  @Idempotent()
  async create(
    @Body() body: CreateConciergeAssignmentRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateConciergeAssignmentResponse> {
    const ctx = requireContext(request);

    const result = await this.assignments.create({
      householdId: body.householdId,
      primaryConciergeUserId: body.primaryConciergeUserId,
      primaryConciergeDisplayName: body.primaryConciergeDisplayName,
      backupConciergeUserId: body.backupConciergeUserId ?? null,
      backupConciergeDisplayName: body.backupConciergeDisplayName ?? null,
      // Authoritative attribution from the verified token, not the body.
      assignedByUserId: ctx.userId,
    });
    if (!result.ok) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'Another assignment for this household was created concurrently. Refresh and try again.',
      });
    }

    const response: CreateConciergeAssignmentResponse = { assignment: result.value };
    // Defence-in-depth: validate the response shape at the boundary so a
    // future drift between the service projection + contract surfaces here
    // rather than at the consumer.
    return CreateConciergeAssignmentResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/assignments/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMine(@Req() request: RequestWithContext): Promise<ConciergeAssignmentSnapshotResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);
    const assignment = await this.assignments.getActiveForHousehold(householdId);
    const response: ConciergeAssignmentSnapshotResponse = { householdId, assignment };
    return ConciergeAssignmentSnapshotResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/assignments')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  async list(
    @Query(new ZodValidationPipe(ListConciergeAssignmentsQuerySchema))
    query: ListConciergeAssignmentsQuery,
  ): Promise<ConciergeAssignmentsListResponse> {
    const assignments = await this.assignments.listForHousehold({
      householdId: query.householdId,
      activeOnly: query.activeOnly ?? false,
      limit: query.limit,
    });
    const response: ConciergeAssignmentsListResponse = { assignments: [...assignments] };
    return ConciergeAssignmentsListResponseSchema.parse(response);
  }

  @Delete('api/v1/concierge/assignments/:assignmentId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  @Idempotent()
  async end(
    @Param('assignmentId', new ZodValidationPipe(AssignmentIdSchema))
    assignmentId: string,
  ): Promise<EndConciergeAssignmentResponse> {
    const outcome = await this.assignments.endAssignment(assignmentId);
    const response: EndConciergeAssignmentResponse = { outcome, assignmentId };
    return EndConciergeAssignmentResponseSchema.parse(response);
  }
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

/**
 * Resolve the household the family actor is acting in from the token's
 * `tenantScope`. The `/me` surface is for household-scoped actors only —
 * an admin (global scope) or partner (tenant scope) token has no "my
 * household" to read, so it gets a 400 rather than a silent empty result.
 */
function requireHouseholdScope(ctx: RequestContext): string {
  if (ctx.tenantScope.type !== 'household') {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail:
        `This endpoint is only available to household members. If you belong to more ` +
        `than one household, name the one you are acting in with the ` +
        `${HOUSEHOLD_SCOPE_HEADER} header.`,
    });
  }
  return ctx.tenantScope.householdId;
}
