import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ListSearchRankingConfigResponseSchema,
  MeResponseSchema,
  SEARCH_RANKING_DESCRIPTION_MAX_LENGTH,
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  SEARCH_RANKING_REGION_CODE_MAX_LENGTH,
  SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_MAX,
  SEARCH_RANKING_TIER_WEIGHT_MIN,
  type ListSearchRankingConfigResponse,
  type MeResponse,
  type SearchRankingConfig,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import {
  createRankingConfigAction,
  deleteRankingConfigAction,
  upsertRankingConfigAction,
} from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Search ranking — Taste & See Admin',
};

/**
 * Admin search ranking-config browser (TS-211-followup-2; PRD §10.5,
 * PDD §14.1).
 *
 * Lists every per-region tier-weight row maintained by ops. The
 * canonical `global` row is always pinned to the top — it's the
 * load-bearing fallback that service-search's resolver consults when
 * a per-region row is absent. Each row has an inline edit form
 * (weights + description) gated behind the server action; the
 * `global` row's delete affordance is disabled with a tooltip
 * explaining the 422 (`global_protected`).
 *
 * The page enforces the same three gates every admin surface does:
 *
 *   1. Authenticated (cookie present) — the (protected) layout's
 *      cheap cookie check + the gateway's 401-on-missing-bearer.
 *   2. MFA-verified — gateway-side requirement for any admin actor.
 *   3. Active super_admin role — Phase-1 only super_admins land on
 *      admin tooling.
 */
export default async function RankingConfigPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasSuperAdminRole(me)) redirect('/dashboard/no-access');

  const list = await fetchRankingConfig();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — search ranking</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Search ranking weights</h1>
        <p>
          Per-region tier-weight multipliers consumed by service-search&apos;s ranking layer at
          query time (PDD §14.1). The <code>global</code> row is the load-bearing fallback for every
          region the resolver doesn&apos;t have a per-region row for — it cannot be deleted, only
          updated.
        </p>
        <p className="user-detail__hint">
          Tier weights are multipliers applied to the base relevance score. Defaults: Basic{' '}
          {SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT}, Certified{' '}
          {SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT}, Elite{' '}
          {SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT}. Bounds: {SEARCH_RANKING_TIER_WEIGHT_MIN}–
          {SEARCH_RANKING_TIER_WEIGHT_MAX}.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Configured regions</h2>
          {list === null ? (
            <p className="auth-alert">
              We couldn&apos;t load the ranking-config table right now. The downstream search
              service may be unreachable.
            </p>
          ) : (
            <RankingConfigList list={list} />
          )}
        </section>

        <NewRegionForm />
      </main>
    </div>
  );
}

function RankingConfigList({
  list,
}: {
  readonly list: ListSearchRankingConfigResponse;
}): React.JSX.Element {
  if (list.configs.length === 0) {
    return (
      <div className="user-empty">
        <p>No ranking-config rows yet. The migration should have seeded the global row.</p>
      </div>
    );
  }

  // Pin `global` first; sort the rest alphabetically.
  const sorted = [...list.configs].sort((a, b) => {
    if (a.regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL) return -1;
    if (b.regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL) return 1;
    return a.regionCode.localeCompare(b.regionCode);
  });

  return (
    <div className="user-detail__actions-grid">
      {sorted.map((config) => (
        <RankingConfigCard key={config.id} config={config} />
      ))}
    </div>
  );
}

function RankingConfigCard({
  config,
}: {
  readonly config: SearchRankingConfig;
}): React.JSX.Element {
  const isGlobal = config.regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL;
  const upsertBound = upsertRankingConfigAction.bind(null, config.regionCode);
  const deleteBound = deleteRankingConfigAction.bind(null, config.regionCode);

  return (
    <div className="user-detail__action-card">
      <h3 className="user-detail__role-name">
        <code>{config.regionCode}</code>
        {isGlobal && (
          <>
            {' '}
            <span className="user-row__chip">fallback</span>
          </>
        )}
      </h3>
      <p className="user-detail__hint">
        Updated{' '}
        {new Date(config.updatedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
        {config.updatedByUserId !== null && (
          <>
            {' '}
            by <code>{config.updatedByUserId}</code>
          </>
        )}
      </p>

      <form action={upsertBound} className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Description</span>
          <input
            type="text"
            name="description"
            defaultValue={config.description ?? ''}
            maxLength={SEARCH_RANKING_DESCRIPTION_MAX_LENGTH}
            placeholder="Why these weights?"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Basic weight</span>
          <input
            type="number"
            name="tierWeightBasic"
            defaultValue={config.tierWeightBasic}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <label className="user-detail__action-label">
          <span>Certified weight</span>
          <input
            type="number"
            name="tierWeightCertified"
            defaultValue={config.tierWeightCertified}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <label className="user-detail__action-label">
          <span>Elite weight</span>
          <input
            type="number"
            name="tierWeightElite"
            defaultValue={config.tierWeightElite}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          Save weights
        </button>
      </form>

      <form action={deleteBound} className="user-detail__action-form">
        <button
          type="submit"
          className="user-detail__action-button user-detail__action-button--danger"
          disabled={isGlobal}
          title={
            isGlobal ? 'The global row cannot be deleted — update its weights instead.' : undefined
          }
        >
          Delete region
        </button>
      </form>
    </div>
  );
}

function NewRegionForm(): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Add region</h2>
      <p className="user-detail__hint">
        Region code must be lower-case alphanumeric, <code>_</code>, or <code>-</code> (e.g.{' '}
        <code>nyc</code>, <code>bay_area</code>). Max {SEARCH_RANKING_REGION_CODE_MAX_LENGTH}{' '}
        characters.
      </p>
      <form action={createRankingConfigAction} className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Region code</span>
          <input
            type="text"
            name="regionCode"
            required
            maxLength={SEARCH_RANKING_REGION_CODE_MAX_LENGTH}
            pattern="[a-z0-9][a-z0-9_-]*"
            placeholder="nyc"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Description</span>
          <input
            type="text"
            name="description"
            maxLength={SEARCH_RANKING_DESCRIPTION_MAX_LENGTH}
            placeholder="Why this region needs its own weights"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Basic weight</span>
          <input
            type="number"
            name="tierWeightBasic"
            defaultValue={SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <label className="user-detail__action-label">
          <span>Certified weight</span>
          <input
            type="number"
            name="tierWeightCertified"
            defaultValue={SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <label className="user-detail__action-label">
          <span>Elite weight</span>
          <input
            type="number"
            name="tierWeightElite"
            defaultValue={SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT}
            step="0.01"
            min={SEARCH_RANKING_TIER_WEIGHT_MIN}
            max={SEARCH_RANKING_TIER_WEIGHT_MAX}
            required
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          Add region
        </button>
      </form>
    </section>
  );
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Ranking weights updated.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      {bannerMessageFor(banner.code)}
    </p>
  );
}

function bannerMessageFor(code: string): string {
  switch (code) {
    case 'region-required':
      return 'A region code is required.';
    case 'region-invalid':
      return 'Region code must be lower-case alphanumeric with _ or - (and start with a letter or digit).';
    case 'weight-required':
      return 'All three tier weights are required.';
    case 'weight-invalid':
      return `Each tier weight must be a finite number between ${SEARCH_RANKING_TIER_WEIGHT_MIN} and ${SEARCH_RANKING_TIER_WEIGHT_MAX}.`;
    case 'description-too-long':
      return `Description must be at most ${SEARCH_RANKING_DESCRIPTION_MAX_LENGTH} characters.`;
    case 'protected':
      return 'The global row cannot be deleted — update its weights instead.';
    case 'not-found':
      return "We couldn't find that region — it may have been removed.";
    case 'bad-request':
      return 'The update was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The search service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchRankingConfig(): Promise<ListSearchRankingConfigResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/search/ranking-config');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = ListSearchRankingConfigResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>
        Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
        our team is already on it.
      </p>
    </main>
  );
}
