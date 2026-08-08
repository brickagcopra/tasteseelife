import type { ProviderDiscoveryHit, SponsoredListing } from '@taste-and-see/contracts';

/**
 * Reserve the top results slots for resolved sponsored providers (TS-218b;
 * PRD §10.9, PDD §18.1).
 *
 * Given the organic page hits (in relevance order, each `sponsored: null`)
 * and the sponsored listings the service-ads resolve returned (TS-218a — an
 * ordered, provider-deduped subset of the organic candidate ids we sent),
 * this promotes each sponsored provider to the TOP of the page in listing
 * order and stamps its winning `{ campaignId, creativeId }` on the hit. The
 * remaining organic hits follow in their original relevance order, each left
 * `sponsored: null`.
 *
 * Pure + deterministic. A listing whose provider is not among `hits` (cannot
 * happen for a candidate-scoped resolve, but defended) is ignored, and a
 * provider is never seated in two slots. With no listings it is the identity
 * mapping (every hit normalised to `sponsored: null`).
 */
export function applySponsoredSlots(
  hits: readonly ProviderDiscoveryHit[],
  listings: readonly SponsoredListing[],
): ProviderDiscoveryHit[] {
  if (listings.length === 0) {
    return hits.map((hit) => ({ ...hit, sponsored: null }));
  }

  const hitByProvider = new Map(hits.map((hit) => [hit.document.providerId, hit]));
  const seated = new Set<string>();
  const sponsoredHits: ProviderDiscoveryHit[] = [];

  for (const listing of listings) {
    if (seated.has(listing.providerId)) continue;
    const hit = hitByProvider.get(listing.providerId);
    if (hit === undefined) continue;
    seated.add(listing.providerId);
    sponsoredHits.push({
      ...hit,
      sponsored: { campaignId: listing.campaignId, creativeId: listing.creativeId },
    });
  }

  const rest = hits
    .filter((hit) => !seated.has(hit.document.providerId))
    .map((hit) => ({ ...hit, sponsored: null }));

  return [...sponsoredHits, ...rest];
}
