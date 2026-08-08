import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  UpsertSeniorIntakeRequestSchema,
  type SeniorIntakeResponse,
  type UpsertSeniorIntakeRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { IntakeService } from '../services/intake.service';

/**
 * Senior intake HTTP boundary (TS-031).
 *
 * Two endpoints today:
 *
 *   PUT /api/v1/seniors/:seniorId/intake
 *     Idempotent upsert of the intake form. The body is the full
 *     SeniorIntake DTO — every save is a complete picture, not a
 *     partial patch. Returns the read-back response with audit metadata.
 *
 *   GET /api/v1/seniors/:seniorId/intake
 *     Read the current intake. Returns the empty-shape response when
 *     the intake has never been completed (operational defaults + null
 *     sensitive fields).
 *
 * Authentication. Both endpoints require a valid Bearer access token
 * minted by `service-identity`. The `AccessTokenGuard` attaches a
 * `requestContext` carrying the caller's userId; the IntakeService
 * then performs the household-membership check (CLAUDE.md §3.2 row-
 * level authorisation).
 *
 * Idempotency. Two layers:
 *
 *   1. PUT is naturally idempotent on `(seniorId, body)` — the same
 *      payload sent twice converges to the same persisted state.
 *
 *   2. Local replay cache (TS-044-followup-1). The PUT endpoint is
 *      decorated with `@Idempotent()` so the global
 *      `IdempotencyInterceptor` from `@taste-and-see/nest-idempotency`
 *      claims a Redis slot per `Idempotency-Key`, body-hashes the
 *      request, and replays the cached HTTP response (status + body +
 *      content-type) for any retry within the 24h TTL. A same-key-
 *      different-body retry returns 409 with a problem-shaped body. A
 *      concurrent in-flight retry returns 409 + `Retry-After`. The
 *      cache short-circuits the handler entirely, defeating partial-
 *      success bugs where the DB write succeeded but the response was
 *      lost on the wire.
 *
 * Tenant scoping. Today enforced in `IntakeService.loadAuthorisedSenior`
 * via an explicit membership lookup. TS-141 will move the enforcement
 * down to a Prisma extension so the controller cannot bypass it.
 */
@Controller('api/v1/seniors')
export class IntakeController {
  private readonly logger = new Logger(IntakeController.name);

  constructor(private readonly intake: IntakeService) {}

  /**
   * PUT /api/v1/seniors/:seniorId/intake — upsert the intake form.
   *
   * Status codes:
   *   200 OK            — intake persisted; body is the read-back DTO.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Put(':seniorId/intake')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async upsert(
    @Param('seniorId') seniorId: string,
    @Body(new ZodValidationPipe(UpsertSeniorIntakeRequestSchema)) input: UpsertSeniorIntakeRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SeniorIntakeResponse> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId },
        'intake upsert carried Idempotency-Key',
      );
    }
    return this.intake.upsert({ seniorId, requesterUserId: userId, intake: input });
  }

  /**
   * GET /api/v1/seniors/:seniorId/intake — read the current intake.
   *
   * Status codes:
   *   200 OK            — body is the intake response (operational
   *                       defaults + null sensitive fields when the
   *                       intake has never been completed).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Get(':seniorId/intake')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorIntakeResponse> {
    const userId = requireUserId(request);
    return this.intake.get({ seniorId, requesterUserId: userId });
  }
}

/**
 * Pull the userId out of the request context attached by the
 * AccessTokenGuard. Throws 401 if missing — would only happen if a
 * controller method forgot the `@UseGuards(AccessTokenGuard)`
 * decorator, in which case failing closed is the right behaviour.
 */
function requireUserId(request: RequestWithContext): string {
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

/**
 * Idempotency keys are opaque tokens supplied by clients; not strictly
 * secret, but better not to log them in full for the same reason we
 * don't log full request IDs everywhere — they're correlation handles.
 * First 8 + last 4 is plenty for support-grade tracing.
 */
function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
