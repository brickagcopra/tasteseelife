import { Module } from '@nestjs/common';

import { EmergencyContactsController } from './controllers/emergency-contacts.controller';
import { EmergencyContactsService } from './services/emergency-contacts.service';

/**
 * Emergency-contacts module (TS-032).
 *
 * Owns the household-scoped roster of "who to call when something's
 * wrong". Plain-column storage rationale lives on the EmergencyContact
 * Prisma model — phone, name, and relationship are operational data
 * the concierge and visit-prep flows consume directly.
 *
 * Exports the service so future cross-module flows (admin tooling
 * roster reads, audit-svc lookups) can reuse it.
 */
@Module({
  controllers: [EmergencyContactsController],
  providers: [EmergencyContactsService],
  exports: [EmergencyContactsService],
})
export class EmergencyContactsModule {}
