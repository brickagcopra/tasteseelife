import { Module } from '@nestjs/common';

import { MemoryRecipesController } from './controllers/memory-recipes.controller';
import { MemoryRecipesService } from './services/memory-recipes.service';

/**
 * Memory recipes module (TS-033).
 *
 * Owns the per-senior catalog of culturally / personally meaningful
 * dishes. Plain-column storage rationale lives on the MemoryRecipe
 * Prisma model — title, description, cuisine tag, image-key pointer
 * are operational data the family dashboard, visit-prep card, and
 * chef portal consume directly.
 *
 * Exports the service so future cross-module flows (booking-svc visit
 * prep, admin tooling catalog reads, audit-svc lookups) can reuse it.
 */
@Module({
  controllers: [MemoryRecipesController],
  providers: [MemoryRecipesService],
  exports: [MemoryRecipesService],
})
export class MemoryRecipesModule {}
