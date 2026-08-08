import { Inject, Injectable, Logger } from '@nestjs/common';
import { DUNNING_TEMPLATE_CATEGORY, DUNNING_TEMPLATE_LOCALE } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { DispatchOrchestratorService } from '../dispatch/services/dispatch-orchestrator.service';

import { BillingContactsClient } from './clients/billing-contacts.client';
import { DunningMetrics } from './dunning-metrics';
import { dunningIdempotencyKey, type DunningRung } from './dunning-rung';

/**
 * Turns a selected rung into sent email (TS-042-followup-3a2).
 *
 * The rung decision is pure and lives in `dunning-rung.ts`; this is the half
 * that talks to other services. One method, called by all three handlers,
 * because the recipient resolution is identical whichever rung fired.
 *
 * **Every non-send path is a logged, counted OUTCOME — never a silent
 * return.** A dunning ladder that quietly mails nobody looks exactly like a
 * dunning ladder with no failures to report, and the difference is a family
 * whose care lapses without warning. The outcome union below is the list of
 * ways this can end, and each one names what an operator would have to fix.
 */
export type DunningDispatchOutcome =
  /** Sent (or replayed) to at least one recipient. */
  | { readonly kind: 'sent'; readonly recipientCount: number; readonly replayedCount: number }
  /** The rung itself decided there was nothing to say (routine renewal). */
  | { readonly kind: 'skipped_rung'; readonly reason: string }
  /** `customerGroup` this ladder has no resolver for. */
  | { readonly kind: 'skipped_customer_group'; readonly customerGroup: string }
  /**
   * The customer resolved to nobody: a household with no active payer, or
   * a provider id matching no row. One outcome rather than two because the
   * consequence is identical — a paying customer about to lose service with
   * nobody told — and the log line carries the group that distinguishes the
   * remedy.
   */
  | { readonly kind: 'no_payer' }
  /** Payers resolved, but no active account with an address among them. */
  | { readonly kind: 'no_deliverable_contact'; readonly payerCount: number };

@Injectable()
export class DunningLadderService {
  private readonly logger = new Logger(DunningLadderService.name);

  constructor(
    private readonly contacts: BillingContactsClient,
    private readonly dispatcher: DispatchOrchestratorService,
    private readonly metrics: DunningMetrics,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  /**
   * Log, meter, return — in one place so a new outcome cannot be added with
   * only two of the three. Every `return` in `deliver` goes through here.
   */
  private record(
    outcome: DunningDispatchOutcome,
    templateCode: string | null,
  ): DunningDispatchOutcome {
    this.metrics.record(outcome, templateCode);
    return outcome;
  }

  /** The two strings the templates need that no event carries. */
  get templateConfig(): { appName: string; billingUrl: string } {
    return { appName: this.env.DUNNING_APP_NAME, billingUrl: this.env.DUNNING_BILLING_URL };
  }

  async deliver(input: {
    readonly rung: DunningRung;
    readonly eventId: string;
    readonly eventName: string;
    readonly customerId: string;
    readonly customerGroup: string;
    readonly subscriptionId: string;
  }): Promise<DunningDispatchOutcome> {
    const { rung, eventId, eventName, customerId, customerGroup, subscriptionId } = input;

    if (rung.kind === 'skip') {
      this.logger.log(
        { eventName, eventId, subscriptionId, reason: rung.reason },
        'dunning.rung-skipped',
      );
      return this.record({ kind: 'skipped_rung', reason: rung.reason }, null);
    }

    // `family` and `provider` each have a billing-contact resolver
    // (TS-042-followup-3a1 / -3a1a). `academy` has none — and it is NOT the
    // same shape: its `customerId` is already a userId, so it needs no
    // resolver hop at all, just a decision about whether academy
    // subscriptions should dun. Left unsupported deliberately rather than
    // guessed at.
    //
    // WARN, not `log` — a subscription entering dunning with no resolver is
    // a real customer who will not be told, and the gap must be visible on
    // a dashboard rather than discovered by the customer.
    if (customerGroup !== 'family' && customerGroup !== 'provider') {
      this.logger.warn(
        { eventName, eventId, subscriptionId, customerGroup },
        'dunning.customer-group-unsupported',
      );
      return this.record({ kind: 'skipped_customer_group', customerGroup }, null);
    }

    // Two resolvers, two shapes, normalised HERE rather than in the
    // contracts. A household has an ARRAY of payers because it genuinely
    // can have several and picking one would silently drop the other; a
    // provider has ONE owner because `providers.user_id` is `@unique`.
    // Flattening them into "the people to tell" is this consumer's job —
    // making the provider contract carry a one-element array would have
    // asserted a plurality the schema forbids.
    const payerUserIds =
      customerGroup === 'family'
        ? (await this.contacts.resolveHouseholdPayers([customerId])).flatMap(
            (contact) => contact.payerUserIds,
          )
        : (await this.contacts.resolveProviderOwners([customerId])).map(
            (contact) => contact.ownerUserId,
          );

    if (payerUserIds.length === 0) {
      // Both resolvers omit an unresolved id rather than returning an empty
      // row, so this is the same signal each of them WARNs about. Repeated
      // here because from this side it means a specific customer is about
      // to lose service with nobody told. `customerGroup` is on the line
      // because the remedy differs: a household with no active payer is a
      // membership problem, a provider that does not resolve is a dangling
      // reference in the subscription.
      this.logger.warn(
        { eventName, eventId, subscriptionId, customerGroup, customerId },
        'dunning.no-active-payer',
      );
      return this.record({ kind: 'no_payer' }, rung.templateCode);
    }

    const recipientContacts = await this.contacts.resolveRecipientContacts(payerUserIds);
    // A suspended or deactivated account is not a deliverable inbox. Skip it
    // rather than mail it, but count it — if EVERY payer is inactive, the
    // household is unreachable and that is the outcome below.
    const deliverable = recipientContacts.filter((contact) => contact.status === 'active');

    if (deliverable.length === 0) {
      this.logger.warn(
        {
          eventName,
          eventId,
          subscriptionId,
          customerGroup,
          customerId,
          payerCount: payerUserIds.length,
        },
        'dunning.no-deliverable-contact',
      );
      return this.record(
        { kind: 'no_deliverable_contact', payerCount: payerUserIds.length },
        rung.templateCode,
      );
    }

    let replayedCount = 0;
    for (const contact of deliverable) {
      const result = await this.dispatcher.dispatch({
        recipientUserId: contact.userId,
        channel: 'email',
        category: DUNNING_TEMPLATE_CATEGORY,
        templateCode: rung.templateCode,
        locale: DUNNING_TEMPLATE_LOCALE,
        recipientAddress: contact.email,
        variables: rung.variables,
        // Quiet hours are HONOURED. A 3am "your card was declined" is not an
        // emergency, and the whole ladder runs on a grace window measured in
        // weeks — nothing here is worth waking a household for.
        bypassQuietHours: false,
        idempotencyKey: dunningIdempotencyKey(eventId, contact.userId),
        sourceEventId: eventId,
      });
      if (result.replayed) {
        replayedCount += 1;
      }
    }

    this.logger.log(
      {
        eventName,
        eventId,
        subscriptionId,
        templateCode: rung.templateCode,
        recipientCount: deliverable.length,
        replayedCount,
      },
      'dunning.dispatched',
    );
    return this.record(
      { kind: 'sent', recipientCount: deliverable.length, replayedCount },
      rung.templateCode,
    );
  }
}
