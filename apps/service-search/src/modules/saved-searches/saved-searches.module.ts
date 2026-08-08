import { Module } from '@nestjs/common';

import { SavedSearchesController } from './controllers/saved-searches.controller';
import { SavedSearchesService } from './services/saved-searches.service';

/**
 * TS-215 saved-searches module. Wires the authenticated controller +
 * the persistence service. The service depends on `PrismaService` from
 * the global `PrismaModule`.
 */
@Module({
  controllers: [SavedSearchesController],
  providers: [SavedSearchesService],
  exports: [SavedSearchesService],
})
export class SavedSearchesModule {}
