import type { AdCreativeKind } from '@taste-and-see/contracts';

/**
 * The five predefined ad placements (TS-272a; PRD §10.9; PDD §18.1 inventory
 * model — "home banner, search top-tile, dashboard sidebar, blog footer,
 * partner co-marketing card"). Seeded idempotently into `ads.ad_placements` by
 * `seedAdPlacements`, keyed on the stable `slotCode`.
 *
 * `slotCode` is the UI-position identifier the delivery surfaces address the
 * slot by — `search_top_tile` deliberately matches the constant service-search
 * already POSTs when resolving sponsored listings (TS-218b), so the seeded row
 * and the live caller agree. `supportedCreativeKinds` constrains which creative
 * kinds may fill each slot.
 */
export interface AdPlacementSeedEntry {
  readonly slotCode: string;
  readonly supportedCreativeKinds: readonly AdCreativeKind[];
}

export const AD_PLACEMENT_SEED: readonly AdPlacementSeedEntry[] = [
  // Home / marketing banner (PDD §18.1 "home banner").
  { slotCode: 'home_banner', supportedCreativeKinds: ['banner'] },
  // Provider-search top tile — the sponsored-listings slot (TS-218 / TS-218b).
  { slotCode: 'search_top_tile', supportedCreativeKinds: ['sponsored_listing'] },
  // Family/provider dashboard sidebar (PDD §18.1 "dashboard sidebar").
  { slotCode: 'dashboard_sidebar', supportedCreativeKinds: ['banner', 'sponsored_content'] },
  // Blog footer placement (PDD §18.1 "blog footer").
  { slotCode: 'blog_footer', supportedCreativeKinds: ['banner', 'sponsored_content'] },
  // Partner co-marketing card (PDD §18.1 "partner co-marketing card").
  { slotCode: 'partner_comarketing_card', supportedCreativeKinds: ['partner_card'] },
] as const;
