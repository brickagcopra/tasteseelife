import { Module } from '@nestjs/common';

import { RecipientContactsController } from './controllers/recipient-contacts.controller';
import { RecipientContactsService } from './services/recipient-contacts.service';

/**
 * Recipient-contacts module (TS-235). Houses the internal
 * `POST /api/v1/internal/identity/recipient-contacts` batch lookup the
 * wellness-summary worker calls to resolve user ids to email + account
 * status. Pinned by the `IDENTITY_RECIPIENT_CONTACTS_API_KEY`
 * shared-secret header (configurable header name via
 * `IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME`).
 *
 * The service injects the global `PrismaService` (provided `@Global()`
 * by `PrismaModule`); the controller pulls `RecipientContactsService`,
 * the `ENV_TOKEN` config, and the global tenant-context store. No
 * exports — this module is internal-only.
 */
@Module({
  controllers: [RecipientContactsController],
  providers: [RecipientContactsService],
})
export class RecipientContactsModule {}
