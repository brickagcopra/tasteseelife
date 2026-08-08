import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import {
  VisitPrepChecklistResponseSchema,
  type DementiaStatus,
  type MemoryRecipe,
  type SeniorMobilityLevel,
  type VisitPrepChecklistResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Provider visit prep checklist page (TS-208).
 *
 * Server component shell:
 *   1. Calls the gateway BFF aggregator at
 *      `GET /api/v1/bookings/:bookingId/prep-checklist`.
 *   2. Renders an empty/error shell on any non-200 result (the
 *      gateway raises a typed problem-details body the provider can
 *      retry against; we don't need to surface the details verbatim
 *      to avoid leaking trace ids etc.).
 *   3. On success, lays out three cards: the visit shape (when /
 *      what / who), the senior's operational profile (allergens
 *      loudly highlighted), and the memory recipes (recipes flagged
 *      `requestedForUpcomingVisit` lead the list).
 *
 * Senior-mode awareness lives in the shared design tokens (linen /
 * espresso / serif). Tap targets stay ≥ 44px via the existing
 * `dash-card`-derived padding.
 *
 * No PII leaks. The page renders ONLY operational fields + the
 * memory recipes the family / senior have already opted into
 * surfacing (the recipes carry no consent gate today — TS-033's
 * design choice — and operational tags are categorical, not free-
 * form). Sensitive senior intake notes (DOB / free-form medical /
 * dietary / allergy / mobility) are deliberately NOT requested from
 * the gateway in TS-208's Phase-1 slice; they land via a follow-up
 * once the senior-consent table exists.
 */

export const metadata: Metadata = {
  title: 'Visit prep — Taste & See Provider Portal',
};

const MOBILITY_LABEL: Record<SeniorMobilityLevel, string> = {
  unknown: 'Not yet shared',
  independent: 'Independent',
  aided_cane: 'Uses a cane',
  aided_walker: 'Uses a walker',
  wheelchair: 'Uses a wheelchair',
  bedridden: 'Bedside care',
};

const DEMENTIA_LABEL: Record<DementiaStatus, string> = {
  none: 'No cognitive concerns noted',
  mild_cognitive_impairment: 'Mild cognitive impairment',
  early_dementia: 'Early-stage dementia',
  moderate_dementia: 'Moderate dementia',
  advanced_dementia: 'Advanced dementia',
};

const SERVICE_KIND_LABEL: Record<string, string> = {
  companion_dining: 'Companion dining',
  personal_chef_visit: 'Personal chef visit',
  grocery_coordination: 'Grocery coordination',
  transportation: 'Transportation',
  social_outing: 'Social outing',
  event_dining: 'Event dining',
  emergency_concierge: 'Emergency concierge',
  holiday_dinner: 'Holiday dinner',
  birthday_experience: 'Birthday experience',
  tea_social: 'Tea social',
  museum_outing: 'Museum outing',
  memory_meal: 'Memory meal',
  custom_request: 'Custom request',
};

interface PageProps {
  readonly params: Promise<{ readonly bookingId: string }>;
}

export default async function VisitPrepPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { bookingId } = await params;

  const result = await callGateway<unknown>(
    `/api/v1/bookings/${encodeURIComponent(bookingId)}/prep-checklist`,
  );
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    return <UnavailableShell bookingId={bookingId} />;
  }

  const parsed = VisitPrepChecklistResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return <UnavailableShell bookingId={bookingId} />;
  }

  return <VisitPrepView checklist={parsed.data} />;
}

function VisitPrepView({
  checklist,
}: {
  readonly checklist: VisitPrepChecklistResponse;
}): React.JSX.Element {
  const { booking, senior, memoryRecipes } = checklist;
  const hasAllergens = senior.allergenTags.length > 0;
  const intakeIncomplete = senior.intakeCompletedAt === null;
  const requestedRecipes = memoryRecipes.filter((r) => r.requestedForUpcomingVisit);
  const otherRecipes = memoryRecipes.filter((r) => !r.requestedForUpcomingVisit);

  return (
    <div className="dash-shell">
      <main className="dash-main">
        <header className="profile-header">
          <h1>Visit prep</h1>
          <p>
            A quick read-only snapshot of the household&apos;s dietary picture, mobility picture,
            and the dishes the family has flagged for this visit. Refresh this page before you head
            over and again on the doorstep.
          </p>
        </header>

        {/*
          TS-304-followup-1 — FIRST, above the intake warning and above the
          prep grid. A provider opens this page on their way to the household;
          everything below it is preparation for a visit that is not going to
          happen. Placing it anywhere else means they read the dietary notes
          and never reach the sentence that matters.

          The copy tells the provider what to DO (stop, contact ops) and not
          WHY. A hold names the provider, the senior, or the household as the
          subject of a high or critical concern — and the provider may be that
          subject. Learning it from a prep screen, with no context and nobody
          to ask, is not how somebody should find out (CLAUDE.md §3.9, §12).
        */}
        {booking.onHold ? (
          <p className="prep-warning" role="status">
            This visit is on hold and should not go ahead. Please do not travel to the household —
            contact the operations team and they will take it from here.
          </p>
        ) : null}

        {intakeIncomplete ? (
          <p className="prep-warning">
            The family hasn&apos;t finished the senior intake yet. Some of the categories below may
            be empty — please call ahead if anything looks thin.
          </p>
        ) : null}

        <div className="prep-grid">
          <article className="prep-card">
            <h2>The visit</h2>
            <dl className="prep-meta-grid">
              <dt>Service</dt>
              <dd>{SERVICE_KIND_LABEL[booking.serviceKind] ?? booking.serviceKind}</dd>
              <dt>Status</dt>
              <dd>
                <span className="prep-status-pill">{booking.status}</span>
              </dd>
              <dt>Starts</dt>
              <dd>{formatDateTime(booking.scheduledStart)}</dd>
              <dt>Ends</dt>
              <dd>{formatDateTime(booking.scheduledEnd)}</dd>
            </dl>
          </article>

          <article className={hasAllergens ? 'prep-card prep-card--allergens' : 'prep-card'}>
            <h2>Allergens to avoid</h2>
            {hasAllergens ? (
              <ul className="prep-chips" aria-label="Allergens to avoid">
                {senior.allergenTags.map((tag) => (
                  <li key={tag} className="prep-chip prep-chip--allergen">
                    {tag.replaceAll('_', ' ')}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="prep-empty">No allergens declared.</p>
            )}
          </article>

          <article className="prep-card">
            <h2>Dietary picture</h2>
            {senior.dietaryTags.length > 0 ? (
              <ul className="prep-chips" aria-label="Dietary preferences">
                {senior.dietaryTags.map((tag) => (
                  <li key={tag} className="prep-chip">
                    {tag.replaceAll('_', ' ')}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="prep-empty">No dietary preferences declared.</p>
            )}
          </article>

          <article className="prep-card">
            <h2>About the senior</h2>
            <dl className="prep-meta-grid">
              <dt>Mobility</dt>
              <dd>{MOBILITY_LABEL[senior.mobilityLevel]}</dd>
              <dt>Memory</dt>
              <dd>{DEMENTIA_LABEL[senior.dementiaStatus]}</dd>
              <dt>Languages</dt>
              <dd>
                {senior.languageTags.length > 0 ? senior.languageTags.join(', ') : 'Not declared'}
              </dd>
            </dl>
          </article>
        </div>

        <section style={{ marginTop: 40 }}>
          <h2
            style={{
              fontFamily: 'var(--serif)',
              fontWeight: 300,
              fontSize: 28,
              color: 'var(--espresso)',
              marginBottom: 16,
            }}
          >
            Memory recipes
          </h2>
          {memoryRecipes.length === 0 ? (
            <p className="prep-empty">No memory recipes on file for this senior yet.</p>
          ) : (
            <>
              {requestedRecipes.length > 0 ? (
                <RecipeGroup
                  heading="Requested for this visit"
                  recipes={requestedRecipes}
                  requested
                />
              ) : null}
              {otherRecipes.length > 0 ? (
                <RecipeGroup
                  heading={
                    requestedRecipes.length > 0 ? 'Other family favourites' : 'Family favourites'
                  }
                  recipes={otherRecipes}
                  requested={false}
                />
              ) : null}
            </>
          )}
        </section>

        <p style={{ marginTop: 32, fontSize: 12, color: 'var(--ink-soft)' }}>
          Snapshot generated {formatDateTime(checklist.generatedAt)}.{' '}
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}

function RecipeGroup({
  heading,
  recipes,
  requested,
}: {
  readonly heading: string;
  readonly recipes: readonly MemoryRecipe[];
  readonly requested: boolean;
}): React.JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <h3
        style={{
          fontFamily: 'var(--sans)',
          fontWeight: 600,
          fontSize: 14,
          color: 'var(--ink-soft)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: '0 0 8px',
        }}
      >
        {heading}
      </h3>
      <ul className="prep-recipes" aria-label={heading}>
        {recipes.map((recipe) => (
          <li
            key={recipe.id}
            className={requested ? 'prep-recipe prep-recipe--requested' : 'prep-recipe'}
          >
            <h3>{recipe.title}</h3>
            <p>{recipe.description}</p>
            {recipe.cuisineTag !== null ? (
              <p className="prep-recipe-meta">{recipe.cuisineTag.replaceAll('_', ' ')}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnavailableShell({ bookingId }: { readonly bookingId: string }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>We&apos;re having a moment</h1>
        <p>
          Your prep checklist for booking <code>{bookingId}</code> is briefly unreachable. Please
          refresh in a few seconds — and if it persists, our team is already on it.
        </p>
        <p>
          <a href="/dashboard">← Back to your dashboard</a>
        </p>
      </main>
    </div>
  );
}

function formatDateTime(iso: string): string {
  // Intl is best-effort here — fall back to the raw ISO string when
  // the runtime hasn't loaded a date formatter (test envs etc.).
  try {
    const date = new Date(iso);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
