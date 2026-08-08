import { Injectable, Logger } from '@nestjs/common';
import type {
  InternalHouseholdBillingContactsResponse,
  InternalHouseholdMembershipsResponse,
} from '@taste-and-see/contracts';
import { HOUSEHOLD_MEMBERSHIPS_MAX, HOUSEHOLD_PRIMARY_PAYERS_MAX } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * "Which households may this user act in?" — the single question this
 * service answers (TS-505d2-followup-5).
 *
 * The api-gateway calls it once per authenticated request (behind a short
 * cache) to establish the request's household tenant scope, which thirteen
 * downstream handlers across service-booking, service-concierge and
 * service-trust-safety require and which no access token has ever carried.
 *
 * **The predicate is `removedAt: null`, deliberately copied rather than
 * reasoned about afresh.** Nine other call sites in this service use
 * exactly that — `HouseholdAccessService.assertActiveMembership`,
 * `IntakeService`, `SeniorsDirectoryService`, `SeniorConsentService`, and
 * so on. `acceptedAt` is NOT part of it. That is a real looseness (an
 * invited-but-unaccepted member counts), but it is the platform's
 * consistent looseness: tightening it here alone would produce the
 * incoherent state where `/api/v1/me/seniors` lists a household the
 * gateway then refuses to scope the same user to. If the definition should
 * tighten, it tightens in all ten places in one task.
 *
 * **No PII.** The response carries household ids and member roles and
 * nothing else — no names, no seniors, no addresses. It is consumed by an
 * authorisation decision, not by a UI, and a hot-path internal route is
 * the last place to widen a projection "while we're here".
 */
@Injectable()
export class HouseholdMembershipsService {
  private readonly logger = new Logger(HouseholdMembershipsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listForUser(args: {
    readonly userId: string;
  }): Promise<InternalHouseholdMembershipsResponse> {
    const rows: ReadonlyArray<MembershipRow> = await this.prisma.householdMember.findMany({
      where: { userId: args.userId, removedAt: null },
      // Deterministic order so a cached value and a fresh one are
      // byte-identical, and so the "exactly one membership" auto-resolution
      // upstream is stable rather than dependent on physical row order.
      orderBy: [{ householdId: 'asc' }],
      select: { householdId: true, memberRole: true },
      // `+ 1` so a user who has somehow exceeded the cap is DETECTED rather
      // than silently truncated into a smaller, wrong answer. The contract
      // caps at HOUSEHOLD_MEMBERSHIPS_MAX; taking one more lets the log
      // below say so.
      take: HOUSEHOLD_MEMBERSHIPS_MAX + 1,
    });

    if (rows.length > HOUSEHOLD_MEMBERSHIPS_MAX) {
      // Truncating an authorisation input without saying so is how a user
      // loses access to a household nobody can explain. WARN, then serve
      // the capped list — the alternative (a 500) locks the account out of
      // every household-scoped surface.
      this.logger.warn(
        { userId: args.userId, membershipCount: rows.length, cap: HOUSEHOLD_MEMBERSHIPS_MAX },
        'user has more active household memberships than the contract cap — response truncated',
      );
    }

    const memberships = rows.slice(0, HOUSEHOLD_MEMBERSHIPS_MAX).map((row) => ({
      householdId: row.householdId,
      memberRole: row.memberRole,
    }));

    this.logger.log(
      { userId: args.userId, membershipCount: memberships.length },
      'listed active household memberships for user',
    );

    return { memberships };
  }

  /**
   * "Who pays for each of these households?" (TS-042-followup-3a1).
   *
   * The missing half of every family-facing billing notification. A
   * subscription's `customer_id` is a `households.id` for the `family`
   * customer group, and until this route existed nothing on the platform
   * could turn one into a person — so a dunning consumer could receive a
   * payment-failure event and have nobody to send it to.
   *
   * Chains into `POST /api/v1/internal/identity/recipient-contacts` for the
   * actual address; this route deliberately stops at user ids so neither
   * hop alone yields a mailable identity.
   *
   * **Same `removedAt: null` predicate as `listForUser`,** copied rather
   * than re-reasoned for the reason stated in the class doc: a definition
   * that differs here from the other ten call sites produces a household
   * that can be acted in but not billed for, or the reverse.
   */
  async resolveBillingContacts(args: {
    readonly householdIds: readonly string[];
  }): Promise<InternalHouseholdBillingContactsResponse> {
    if (args.householdIds.length === 0) {
      return { contacts: [] };
    }

    const rows: ReadonlyArray<PayerRow> = await this.prisma.householdMember.findMany({
      where: {
        householdId: { in: [...args.householdIds] },
        // Payers only. Observers and seniors are excluded HERE rather than
        // left to the caller: a senior learning by email that their care is
        // about to lapse for non-payment is a §12 dignity failure, and the
        // route that would hand out their user id is the right place to
        // make that impossible.
        memberRole: 'primary_payer',
        removedAt: null,
      },
      // Deterministic within a household so a retry and a first attempt
      // produce byte-identical output — the caller may key an idempotent
      // dispatch on it.
      orderBy: [{ householdId: 'asc' }, { userId: 'asc' }],
      select: { householdId: true, userId: true },
    });

    const byHousehold = new Map<string, string[]>();
    for (const row of rows) {
      const existing = byHousehold.get(row.householdId);
      if (existing === undefined) {
        byHousehold.set(row.householdId, [row.userId]);
      } else if (existing.length < HOUSEHOLD_PRIMARY_PAYERS_MAX) {
        existing.push(row.userId);
      }
    }

    const contacts = [...byHousehold.entries()].map(([householdId, payerUserIds]) => ({
      householdId,
      payerUserIds,
    }));

    // A household in the request with no active primary payer is ABSENT
    // from the response, never a row with an empty array (the contract's
    // `.min(1)` makes that unrepresentable). The gap is worth naming in the
    // log: "nobody pays for this household" is a state a human should look
    // at, not a routine miss.
    const unresolvedCount = args.householdIds.length - contacts.length;
    if (unresolvedCount > 0) {
      this.logger.warn(
        { requestedCount: args.householdIds.length, resolvedCount: contacts.length },
        'some households have no active primary payer — billing contacts unresolved',
      );
    }

    // Ids only, never a count of payers per household keyed by id and never
    // an email — this service has no addresses and must not start logging
    // household composition.
    this.logger.log(
      { requestedCount: args.householdIds.length, resolvedCount: contacts.length },
      'resolved household billing contacts',
    );

    return { contacts };
  }
}

/**
 * Explicit row type. `@prisma/client` resolves to the root stub during
 * this service's own type-check (the generated client lives under the
 * service's `node_modules/.prisma/client`), so an un-annotated delegate
 * result degrades to `any` and the `.map` callback below would silently
 * lose its types.
 */
interface MembershipRow {
  readonly householdId: string;
  readonly memberRole: 'primary_payer' | 'family_observer' | 'senior_user';
}

/** Explicit row type for the billing-contacts projection — same reason. */
interface PayerRow {
  readonly householdId: string;
  readonly userId: string;
}
