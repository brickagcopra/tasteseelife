import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type CreateAccountLinkRequest,
  CreateAccountLinkRequestSchema,
  type CreateAccountLinkResponse,
  type CreateConnectAccountRequest,
  CreateConnectAccountRequestSchema,
  type CreateConnectAccountResponse,
  type ListPayoutAccountsQuery,
  ListPayoutAccountsQuerySchema,
  PAYOUT_PROVIDER_ID_MAX_LENGTH,
  type PayoutAccountResponse,
  type PayoutAccountStatus,
  type PayoutAccountsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import {
  toCreateAccountLinkResponse,
  toCreateConnectAccountResponse,
  toPayoutAccountResponse,
  toPayoutAccountsListResponse,
} from '../mappers/payout-account.mapper';
import { PayoutAccountsService } from '../services/payout-accounts.service';

/**
 * Provider self-service + admin endpoints for the Stripe Connect
 * Express onboarding surface (TS-090).
 *
 *   POST /api/v1/payouts/me/connect-account
 *     Idempotent create-or-fetch for the authenticated provider's
 *     Stripe Express account. Returns the account state + `outcome`
 *     flag.
 *
 *   POST /api/v1/payouts/me/onboarding-link
 *     Mint a fresh Stripe `account_onboarding` (default) or
 *     `account_update` link for the authenticated provider.
 *
 *   GET  /api/v1/payouts/me/connect-account
 *     Read the authenticated provider's account state.
 *
 *   GET  /api/v1/admin/payouts/accounts/:providerId
 *     Admin read of any provider's account state. Requires admin role
 *     (lifted to a real @RequirePermissions decorator in TS-090-followup-2).
 *
 *   GET  /api/v1/admin/payouts/accounts
 *     Admin cursor-paginated list with optional status filter.
 *
 * Authorisation model (Phase 1 — TS-090):
 *   - All routes require a verified JWT (AccessTokenGuard).
 *   - `/me/*` routes derive the provider id from `requestContext.userId`.
 *     Phase 1 assumes a 1:1 mapping between `user_id` and `provider_id`
 *     (the provider service stamps a provider row at signup). TS-090-
 *     followup-3 will move this to a tenant-scoped lookup against the
 *     provider service.
 *   - `/admin/*` routes simply require a valid JWT today; the
 *     RBAC permission gate (`payouts:read`) lifts in TS-090-followup-2.
 */
@Controller()
export class ConnectController {
  constructor(private readonly accounts: PayoutAccountsService) {}

  @Post('api/v1/payouts/me/connect-account')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateConnectAccountRequestSchema))
  async createMyConnectAccount(
    @Body() body: CreateConnectAccountRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateConnectAccountResponse> {
    const providerId = extractProviderIdFromRequest(request);

    const result = await this.accounts.createOrFetchForProvider({
      providerId,
      country: body.country ?? 'US',
      defaultCurrency: body.defaultCurrency ?? 'USD',
    });
    return toCreateConnectAccountResponse(result.outcome, result.account);
  }

  @Post('api/v1/payouts/me/onboarding-link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateAccountLinkRequestSchema))
  async createMyOnboardingLink(
    @Body() body: CreateAccountLinkRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateAccountLinkResponse> {
    const providerId = extractProviderIdFromRequest(request);
    const mintInput: {
      providerId: string;
      kind?: 'account_onboarding' | 'account_update';
      refreshUrl: string;
      returnUrl: string;
    } = {
      providerId,
      refreshUrl: body.refreshUrl,
      returnUrl: body.returnUrl,
    };
    if (body.kind !== undefined) mintInput.kind = body.kind;
    const result = await this.accounts.mintAccountLink(mintInput);
    if (result.outcome === 'account_not_found') {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail:
          'No Stripe Connect Express account is on file for this provider. POST /api/v1/payouts/me/connect-account first.',
      });
    }
    return toCreateAccountLinkResponse(result.link);
  }

  @Get('api/v1/payouts/me/connect-account')
  @UseGuards(AccessTokenGuard)
  async getMyConnectAccount(@Req() request: RequestWithContext): Promise<PayoutAccountResponse> {
    const providerId = extractProviderIdFromRequest(request);
    const account = await this.accounts.getByProvider(providerId);
    if (account === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No Stripe Connect Express account is on file for this provider.',
      });
    }
    return toPayoutAccountResponse(account);
  }

  @Get('api/v1/admin/payouts/accounts/:providerId')
  @UseGuards(AccessTokenGuard)
  async getAccountByProvider(
    @Param('providerId') providerId: string,
  ): Promise<PayoutAccountResponse> {
    assertValidProviderId(providerId);
    const account = await this.accounts.getByProvider(providerId);
    if (account === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No Stripe Connect Express account is on file for this provider.',
      });
    }
    return toPayoutAccountResponse(account);
  }

  @Get('api/v1/admin/payouts/accounts')
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(ListPayoutAccountsQuerySchema))
  async listAccounts(@Query() query: ListPayoutAccountsQuery): Promise<PayoutAccountsListResponse> {
    const input: { limit: number; status?: PayoutAccountStatus; cursor?: string } = {
      limit: query.limit,
    };
    if (query.status !== undefined) input.status = query.status;
    if (query.cursor !== undefined) input.cursor = query.cursor;
    const result = await this.accounts.list(input);
    return toPayoutAccountsListResponse(result.rows, result.nextCursor);
  }
}

function extractProviderIdFromRequest(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    // Should be unreachable when behind AccessTokenGuard, but the type
    // system can't see that — keep an explicit guard so a regression
    // surfaces as 401, not as an undefined-id crash.
    throw new NotFoundException({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'request context missing — provider self-service routes require authentication',
    });
  }
  // Phase 1: user id IS the provider id (the provider service stamps a
  // provider row with id == user id on signup). TS-090-followup-3 lifts
  // this to a real provider-id lookup against the provider service.
  return ctx.userId;
}

function assertValidProviderId(providerId: string): void {
  if (providerId.length === 0 || providerId.length > PAYOUT_PROVIDER_ID_MAX_LENGTH) {
    throw new NotFoundException({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'provider id is malformed',
    });
  }
}
