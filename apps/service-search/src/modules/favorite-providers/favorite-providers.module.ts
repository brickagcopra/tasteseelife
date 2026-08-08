import { Module } from '@nestjs/common';

import { FavoriteProvidersController } from './controllers/favorite-providers.controller';
import { FavoriteProvidersService } from './services/favorite-providers.service';

/**
 * TS-215 favorite-providers module. Wires the authenticated controller +
 * the persistence service. The service depends on `PrismaService` from
 * the global `PrismaModule`.
 */
@Module({
  controllers: [FavoriteProvidersController],
  providers: [FavoriteProvidersService],
  exports: [FavoriteProvidersService],
})
export class FavoriteProvidersModule {}
