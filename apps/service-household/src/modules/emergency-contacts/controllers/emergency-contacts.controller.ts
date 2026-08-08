import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CreateEmergencyContactRequestSchema,
  UpdateEmergencyContactRequestSchema,
  type CreateEmergencyContactRequest,
  type EmergencyContact,
  type EmergencyContactsListResponse,
  type UpdateEmergencyContactRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { EmergencyContactsService } from '../services/emergency-contacts.service';

/**
 * Household emergency-contacts HTTP boundary (TS-032).
 *
 * Endpoints:
 *
 *   GET    /api/v1/households/:householdId/emergency-contacts
 *     List active contacts in priority-then-createdAt order.
 *
 *   POST   /api/v1/households/:householdId/emergency-contacts
 *     Create a new contact. 422 if the household is at the 10-contact cap.
 *
 *   PATCH  /api/v1/households/:householdId/emergency-contacts/:contactId
 *     Patch one or more fields. Empty body is 400. (`PATCH` rather than
 *     `PUT` because partial updates are the dominant client-side use case
 *     — bumping priority, fixing a typo — and PUT would require the
 *     client to round-trip the entire DTO on every change.)
 *
 *   DELETE /api/v1/households/:householdId/emergency-contacts/:contactId
 *     Soft-delete. Idempotent.
 *
 * Authentication. Bearer access token; the service layer enforces
 * household membership.
 *
 * Idempotency. Every write endpoint (POST/PATCH/DELETE) is decorated
 * with `@Idempotent()` so the global `IdempotencyInterceptor` from
 * `@taste-and-see/nest-idempotency` claims a Redis slot per
 * `Idempotency-Key`, body-hashes the request, and replays the cached
 * HTTP response for any retry within the 24h TTL (TS-044-followup-1).
 * A same-key-different-body retry returns 409. The cache short-circuits
 * the handler entirely, closing the per-household cap race window on
 * the create path documented in TS-032-followup-5.
 */
@Controller('api/v1/households')
export class EmergencyContactsController {
  private readonly logger = new Logger(EmergencyContactsController.name);

  constructor(private readonly contacts: EmergencyContactsService) {}

  @Get(':householdId/emergency-contacts')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('householdId') householdId: string,
    @Req() request: RequestWithContext,
  ): Promise<EmergencyContactsListResponse> {
    const userId = requireUserId(request);
    return this.contacts.list({ householdId, requesterUserId: userId });
  }

  /**
   * Status codes:
   *   201 Created       — contact persisted; body is the created DTO.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the household.
   *   404 Not Found     — household does not exist.
   *   422 Unprocessable — household is at the per-household contact cap.
   */
  @Post(':householdId/emergency-contacts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async create(
    @Param('householdId') householdId: string,
    @Body(new ZodValidationPipe(CreateEmergencyContactRequestSchema))
    input: CreateEmergencyContactRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<EmergencyContact> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), householdId },
        'emergency-contact create carried Idempotency-Key',
      );
    }
    return this.contacts.create({ householdId, requesterUserId: userId, input });
  }

  /**
   * Status codes:
   *   200 OK            — updated; body is the read-back DTO.
   *   400 Bad Request   — payload failed validation OR empty body.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the household.
   *   404 Not Found     — household or contact does not exist.
   */
  @Patch(':householdId/emergency-contacts/:contactId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async update(
    @Param('householdId') householdId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(UpdateEmergencyContactRequestSchema))
    input: UpdateEmergencyContactRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<EmergencyContact> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), householdId, contactId },
        'emergency-contact update carried Idempotency-Key',
      );
    }
    return this.contacts.update({ householdId, contactId, requesterUserId: userId, input });
  }

  /**
   * Status codes:
   *   204 No Content    — removed (or already removed; idempotent).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the household.
   *   404 Not Found     — household or contact does not exist.
   */
  @Delete(':householdId/emergency-contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async remove(
    @Param('householdId') householdId: string,
    @Param('contactId') contactId: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<void> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), householdId, contactId },
        'emergency-contact remove carried Idempotency-Key',
      );
    }
    await this.contacts.remove({ householdId, contactId, requesterUserId: userId });
  }
}

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

function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
