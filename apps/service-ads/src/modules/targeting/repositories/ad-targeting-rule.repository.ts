import { Injectable, Logger } from '@nestjs/common';
import {
  parseAdTargetingPredicate,
  type AdTargetingRule,
  type AdTargetingRuleKind,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The decoded targeting rules for a campaign, plus a count of rows that
 * failed to decode. A malformed row is one whose persisted `value` TEXT is
 * not a valid predicate AST (`invalid_json` / `invalid_shape`); it is
 * skipped here and surfaced via `malformedCount` so the delivery evaluator
 * can fail the whole campaign closed (a corrupt rule must never widen reach).
 */
export interface LoadedCampaignRules {
  readonly rules: readonly AdTargetingRule[];
  readonly malformedCount: number;
}

/**
 * Reads + decodes a campaign's targeting rules from `ad_targeting_rules`
 * (TS-273; PDD §8.2, §18.1).
 *
 * `AdTargetingRule` is an `unscopedModel` (platform-wide marketing-admin
 * inventory — see `app.module.ts`), so the tenant-scope gate short-circuits
 * to `proceed_unscoped_model` BEFORE any request-context check: this read
 * needs no `RequestContext` frame and no `runWithoutTenantContext` wrapper.
 */
@Injectable()
export class AdTargetingRuleRepository {
  private readonly logger = new Logger(AdTargetingRuleRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load + decode every targeting rule row for a campaign. Rows are read
   * with an explicit projection (CLAUDE.md §4.1 — no `SELECT *`); each
   * `value` is decoded through the shared grammar parser. A row that fails
   * to decode is warn-logged (with campaign + rule id, never the payload)
   * and excluded, while `malformedCount` records that it happened.
   */
  async loadCampaignRules(campaignId: string): Promise<LoadedCampaignRules> {
    const rows = (await this.prisma.adTargetingRule.findMany({
      where: { campaignId },
      select: { id: true, kind: true, value: true },
    })) as ReadonlyArray<{ id: string; kind: AdTargetingRuleKind; value: string }>;

    const rules: AdTargetingRule[] = [];
    let malformedCount = 0;

    for (const row of rows) {
      const parsed = parseAdTargetingPredicate(row.value);
      if (!parsed.ok) {
        malformedCount += 1;
        this.logger.warn(
          `malformed targeting rule skipped campaignId=${campaignId} ruleId=${row.id} ` +
            `kind=${row.kind} error=${parsed.error}`,
        );
        continue;
      }
      rules.push({ kind: row.kind, predicate: parsed.predicate });
    }

    return { rules, malformedCount };
  }
}
