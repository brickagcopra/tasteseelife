import { Module } from '@nestjs/common';

import { ActivityController } from './controllers/activity.controller';
import { ActivityService } from './services/activity.service';

/**
 * Activity module (TS-101). Wires:
 *
 *   - `ActivityService` — persistence orchestrator (record + listByUser).
 *   - `ActivityController` — HTTP boundary (internal ingest + self-view
 *     + admin search).
 *
 * `PrismaService` is provided globally by `PrismaModule`.
 * `ENV_TOKEN` is provided globally by `AppConfigModule`.
 * `AccessTokenGuard` is provided globally by `NestAuthModule` (registered
 * from `AppModule` as TS-052-followup-11a — replaces the per-service
 * `common/guards/access-token.guard.ts` copy).
 */
@Module({
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
