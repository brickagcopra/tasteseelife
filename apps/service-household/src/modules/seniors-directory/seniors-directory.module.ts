import { Module } from '@nestjs/common';

import { SeniorsDirectoryController } from './controllers/seniors-directory.controller';
import { SeniorsDirectoryService } from './services/seniors-directory.service';

/**
 * "My seniors" directory module (TS-214).
 *
 * Owns the `GET /api/v1/me/seniors` resolver — the family-portal entry
 * point that maps an authenticated user to the active seniors in the
 * households they belong to. Without it, every per-senior surface (the
 * preference editor, intake, memory recipes) is unreachable from the
 * portal because there is no other user → seniors resolver.
 *
 * Exports the service so future cross-module flows (a household
 * dashboard summary, admin tooling) can reuse the resolver.
 */
@Module({
  controllers: [SeniorsDirectoryController],
  providers: [SeniorsDirectoryService],
  exports: [SeniorsDirectoryService],
})
export class SeniorsDirectoryModule {}
