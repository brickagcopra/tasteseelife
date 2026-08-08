import { Module } from '@nestjs/common';

import { AuditController } from './controllers/audit.controller';
import { AuditService } from './services/audit.service';
import { HashChainService } from './services/hash-chain.service';

/**
 * Audit module (TS-100). Wires:
 *
 *   - `HashChainService` — per-resource SHA-256 chain helper.
 *   - `AuditService` — persistence orchestrator (record + list).
 *   - `AuditController` — HTTP boundary (internal ingest + admin reads).
 *
 * `PrismaService` is provided globally by `PrismaModule`.
 * `ENV_TOKEN` is provided globally by `AppConfigModule`.
 * `AccessTokenGuard` is provided globally by `NestAuthModule` (registered
 * from `AppModule` as TS-052-followup-11a — replaces the per-service
 * `common/guards/access-token.guard.ts` copy).
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, HashChainService],
  exports: [AuditService, HashChainService],
})
export class AuditModule {}
