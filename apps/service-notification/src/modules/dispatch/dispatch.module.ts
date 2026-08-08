import { Module } from '@nestjs/common';
import { ServerClient } from 'postmark';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PreferencesModule } from '../preferences/preferences.module';
import { TemplatesModule } from '../templates/templates.module';

import { EmailDispatcher } from './channels/email-dispatcher.service';
import { POSTMARK_CLIENT_TOKEN, type PostmarkEmailClient } from './channels/postmark.constants';
import { PushDispatcher } from './channels/push-dispatcher.service';
import { SmsDispatcher } from './channels/sms-dispatcher.service';
import { DispatchController } from './controllers/dispatch.controller';
import { DispatchOrchestratorService } from './services/dispatch-orchestrator.service';
import { PreferenceGateService } from './services/preference-gate.service';
import { QuietHoursService } from './services/quiet-hours.service';

/**
 * Notification dispatch module (TS-073). Composes the orchestrator,
 * the gate services, the three channel adapters, and the controller.
 *
 * Depends on:
 *   - `TemplatesModule` — for `TemplatesService.render`.
 *   - `PreferencesModule` — for `PreferencesService.getEffectivePreference`.
 *
 * Both are imported so their providers (`TemplatesService` /
 * `PreferencesService`) are visible via Nest's module-scoped DI.
 *
 * `AccessTokenGuard` is provided globally by `NestAuthModule` (registered
 * from `AppModule` as TS-052-followup-11a — replaces the per-service
 * `common/guards/access-token.guard.ts` copy).
 */
@Module({
  imports: [TemplatesModule, PreferencesModule],
  controllers: [DispatchController],
  providers: [
    /**
     * TS-073-followup-1 — the Postmark client, constructed once here and
     * injected into `EmailDispatcher`.
     *
     * **`null` when `POSTMARK_SERVER_TOKEN` is unset**, which is the
     * stub-mode signal the adapter reads. Constructing it in a factory
     * rather than inside the adapter is what lets a unit test override the
     * token with a fake and never open a socket, and keeps "are we live?" a
     * single decision made from the same value that builds the client.
     *
     * The `postmark` import is deliberately eager rather than a dynamic
     * `import()` inside the factory: a lazy require would turn a missing or
     * broken dependency into a runtime failure on the first email sent —
     * i.e. discovered by a family not receiving one — instead of at boot.
     */
    {
      provide: POSTMARK_CLIENT_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): PostmarkEmailClient | null =>
        env.POSTMARK_SERVER_TOKEN ? new ServerClient(env.POSTMARK_SERVER_TOKEN) : null,
    },
    DispatchOrchestratorService,
    PreferenceGateService,
    QuietHoursService,
    EmailDispatcher,
    SmsDispatcher,
    PushDispatcher,
  ],
  exports: [DispatchOrchestratorService, PreferenceGateService],
})
export class DispatchModule {}
