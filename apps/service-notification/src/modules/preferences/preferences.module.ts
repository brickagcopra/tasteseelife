import { Module } from '@nestjs/common';

import { PreferencesController } from './controllers/preferences.controller';
import { PreferencesService } from './services/preferences.service';

/**
 * Notification preferences module (TS-073). Wires the self-service
 * controller + the orchestration service. Re-exports
 * `PreferencesService` so `DispatchModule` can inject it for the
 * preference-gate path.
 *
 * `AccessTokenGuard` is provided globally by `NestAuthModule` (registered
 * from `AppModule` as TS-052-followup-11a — replaces the per-service
 * `common/guards/access-token.guard.ts` copy).
 */
@Module({
  controllers: [PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
