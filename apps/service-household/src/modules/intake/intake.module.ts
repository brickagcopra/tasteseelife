import { Module } from '@nestjs/common';

import { IntakeController } from './controllers/intake.controller';
import { IntakePayloadCipherService } from './services/intake-payload-cipher.service';
import { IntakeService } from './services/intake.service';

/**
 * Intake bounded module — owns the senior intake form (TS-031).
 *
 * Exports `IntakeService` and `IntakePayloadCipherService` so future
 * cross-module flows (admin-side intake reads, batch encryption-key
 * rotation worker) can reuse them without a module refactor.
 *
 * The `PrismaModule` and `AppConfigModule` are global (declared
 * `@Global()` in their respective modules), so this module only needs
 * to declare its own controllers + providers.
 */
@Module({
  controllers: [IntakeController],
  providers: [IntakeService, IntakePayloadCipherService],
  exports: [IntakeService, IntakePayloadCipherService],
})
export class IntakeModule {}
