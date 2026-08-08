import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalRecipientContactsResponseSchema,
  type RecipientContact,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-identity's recipient-contacts batch
 * (`POST /api/v1/internal/identity/recipient-contacts`). Resolves a batch
 * of userIds to a `userId → contact` map so the orchestrator can address
 * + filter recipients. Unknown ids are simply absent from the map.
 */
@Injectable()
export class RecipientContactsClient {
  private readonly logger = new Logger(RecipientContactsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async resolve(userIds: readonly string[]): Promise<Map<string, RecipientContact>> {
    const map = new Map<string, RecipientContact>();
    if (userIds.length === 0) return map;

    const url = `${trimBaseUrl(this.env.IDENTITY_SERVICE_BASE_URL)}/api/v1/internal/identity/recipient-contacts`;
    const response = await internalRequest({
      service: 'service-identity',
      url,
      method: 'POST',
      headerName: this.env.IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME,
      apiKey: this.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: InternalRecipientContactsResponseSchema,
      logger: this.logger,
      body: { userIds: [...userIds] },
    });

    for (const contact of response.contacts) {
      map.set(contact.userId, contact);
    }
    return map;
  }
}
