import { describe, expect, it, vi } from 'vitest';
import type { AdTargetingRuleKind } from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AdTargetingRuleRepository } from './ad-targeting-rule.repository';

/**
 * AdTargetingRuleRepository unit suite (TS-273).
 *
 * Uses an in-memory FakePrisma (the platform FakePrisma convention) so the
 * decode-and-skip-malformed behaviour is deterministic without a database.
 * The real read of the `unscopedModel` `AdTargetingRule` (no request-context
 * frame needed) is exercised by the Testcontainers followup.
 */

interface RuleRow {
  readonly id: string;
  readonly kind: AdTargetingRuleKind;
  readonly value: string;
}

class FakePrisma {
  constructor(private readonly rowsByCampaign: Map<string, RuleRow[]>) {}

  adTargetingRule = {
    findMany: vi.fn(
      async (args: { where: { campaignId: string } }): Promise<RuleRow[]> =>
        this.rowsByCampaign.get(args.where.campaignId) ?? [],
    ),
  };
}

function repositoryWith(rows: RuleRow[]): AdTargetingRuleRepository {
  const prisma = new FakePrisma(new Map([['cmp_1', rows]]));
  return new AdTargetingRuleRepository(prisma as unknown as PrismaService);
}

describe('AdTargetingRuleRepository.loadCampaignRules', () => {
  it('decodes well-formed rule rows into parsed rules', async () => {
    const repo = repositoryWith([
      {
        id: 'rule_1',
        kind: 'geography',
        value: JSON.stringify({ operator: 'any_of', values: ['NY-Manhattan'] }),
      },
      {
        id: 'rule_2',
        kind: 'behavior_cohort',
        value: JSON.stringify({ operator: 'all_of', values: ['booked_last_30d'] }),
      },
    ]);

    const { rules, malformedCount } = await repo.loadCampaignRules('cmp_1');

    expect(malformedCount).toBe(0);
    expect(rules).toEqual([
      { kind: 'geography', predicate: { operator: 'any_of', values: ['NY-Manhattan'] } },
      { kind: 'behavior_cohort', predicate: { operator: 'all_of', values: ['booked_last_30d'] } },
    ]);
  });

  it('skips a row whose value is not valid JSON and counts it malformed', async () => {
    const repo = repositoryWith([
      { id: 'rule_bad', kind: 'geography', value: '{not json' },
      {
        id: 'rule_ok',
        kind: 'tier',
        value: JSON.stringify({ operator: 'any_of', values: ['tier_3_concierge'] }),
      },
    ]);

    const { rules, malformedCount } = await repo.loadCampaignRules('cmp_1');

    expect(malformedCount).toBe(1);
    expect(rules).toEqual([
      { kind: 'tier', predicate: { operator: 'any_of', values: ['tier_3_concierge'] } },
    ]);
  });

  it('skips a row whose value is valid JSON but the wrong shape', async () => {
    const repo = repositoryWith([
      {
        id: 'rule_shape',
        kind: 'persona',
        value: JSON.stringify({ operator: 'unknown_op', values: [] }),
      },
    ]);

    const { rules, malformedCount } = await repo.loadCampaignRules('cmp_1');

    expect(malformedCount).toBe(1);
    expect(rules).toEqual([]);
  });

  it('returns an empty result for a campaign with no rules', async () => {
    const repo = repositoryWith([]);
    const { rules, malformedCount } = await repo.loadCampaignRules('cmp_1');
    expect(rules).toEqual([]);
    expect(malformedCount).toBe(0);
  });
});
