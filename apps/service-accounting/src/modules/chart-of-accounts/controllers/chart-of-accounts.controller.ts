import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ListAccountsQuerySchema,
  type AccountsListResponse,
  type ListAccountsQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { ChartOfAccountsService } from '../services/chart-of-accounts.service';

/**
 * Read-only chart-of-accounts catalog endpoint.
 *
 * `GET /api/v1/accounts` returns the active chart of accounts ordered
 * by code (canonical accounting display order). The endpoint is
 * authenticated — accounting metadata is staff-only (CLAUDE.md §6
 * treats the accounting subsystem as the financial source of truth).
 *
 * Permission-string gating (`@RequirePermissions('accounting:read')`)
 * lands when the shared `packages/nest-auth` guard package arrives
 * (TS-052-followup-11). Today the `AccessTokenGuard` keeps the
 * endpoint authenticated; downstream tooling (TS-129 admin journal
 * browser) layers role checks on top.
 *
 * No `Idempotency-Key` plumbing here because the endpoint is read-only
 * (CLAUDE.md §3.3 idempotency applies to write endpoints).
 */
@Controller({ path: 'api/v1/accounts' })
@UseGuards(AccessTokenGuard)
export class ChartOfAccountsController {
  private readonly logger = new Logger(ChartOfAccountsController.name);

  constructor(private readonly accounts: ChartOfAccountsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ListAccountsQuerySchema))
  async list(@Query() query: ListAccountsQuery): Promise<AccountsListResponse> {
    const accounts = await this.accounts.list({
      ...(query.type !== undefined && { type: query.type }),
      ...(query.parentId !== undefined && { parentId: query.parentId }),
      activeOnly: query.activeOnly,
    });
    this.logger.log({ count: accounts.length }, 'GET /api/v1/accounts');
    return { accounts: [...accounts] };
  }
}
