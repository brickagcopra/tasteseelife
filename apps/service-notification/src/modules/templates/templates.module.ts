import { Module } from '@nestjs/common';

import { RenderController } from './controllers/render.controller';
import { TemplatesController } from './controllers/templates.controller';
import { HandlebarsRendererService } from './services/handlebars-renderer.service';
import { MjmlCompilerService } from './services/mjml-compiler.service';
import { TemplatesService } from './services/templates.service';
import { VariableValidatorService } from './services/variable-validator.service';

/**
 * Notification templates module (TS-072) — wires the admin CRUD
 * controller, the internal render controller, and the four
 * orchestration services. Depends on the globally-registered
 * `PrismaModule` for the Prisma client.
 *
 * `AccessTokenGuard` is provided globally by `NestAuthModule` (registered
 * from `AppModule` as TS-052-followup-11a — replaces the per-service
 * `common/guards/access-token.guard.ts` copy).
 *
 * Re-exports `TemplatesService` so future channel-dispatcher modules
 * (TS-073) can inject it directly when they want to render in-process
 * (a sibling alternative to the HTTP render endpoint).
 */
@Module({
  controllers: [TemplatesController, RenderController],
  providers: [
    TemplatesService,
    MjmlCompilerService,
    HandlebarsRendererService,
    VariableValidatorService,
  ],
  exports: [TemplatesService],
})
export class TemplatesModule {}
