import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { callGateway } from '@/lib/api';
import { getMyOnboarding, type MyOnboardingResult } from '@/lib/concierge-onboarding-api';
import type { ConciergeOnboardingStepRecord } from '@taste-and-see/contracts';
import { z } from 'zod';

export const metadata: Metadata = {
  title: 'Getting started — Taste & See',
};

const MeBodySchema = z.object({ userId: z.string().min(1) });

/**
 * Family read-only Tier-3 onboarding progress page (TS-228). Shows the
 * household's white-glove kickoff checklist so the family can see where things
 * stand. Read-only — the concierge team drives the steps; the family watches
 * progress.
 */
export default async function FamilyOnboardingPage(): Promise<React.JSX.Element> {
  const me = await callGateway<unknown>('/api/v1/me');
  if (me.kind === 'unauthorized') redirect('/login?expired=1');
  if (me.kind !== 'ok' || !MeBodySchema.safeParse(me.body).success) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  const result = await getMyOnboarding();

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to dashboard
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Getting started with Taste &amp; See</h1>
        <p>
          Welcome. Your concierge team is setting everything up for a warm start. Here&apos;s where
          things stand — there&apos;s nothing you need to do here; we&apos;ll be in touch at each
          step.
        </p>
        <OnboardingBody result={result} />
      </main>
    </div>
  );
}

function OnboardingBody({ result }: { readonly result: MyOnboardingResult }): React.JSX.Element {
  if (result.kind === 'unavailable') {
    return (
      <p className="auth-alert" role="alert">
        We couldn&apos;t load your onboarding right now. Please refresh in a few seconds.
      </p>
    );
  }
  if (result.kind === 'none') {
    return (
      <section className="onboarding-card">
        <p>
          Your onboarding hasn&apos;t started yet. Once you&apos;re on a Concierge Lifestyle plan,
          your dedicated concierge will reach out to begin the kickoff.{' '}
          <Link href="/plans" className="link-inline">
            See plans
          </Link>
          .
        </p>
      </section>
    );
  }

  const { onboarding } = result;
  const pct =
    onboarding.stepsTotal === 0
      ? 0
      : Math.round((onboarding.stepsCompleted / onboarding.stepsTotal) * 100);
  return (
    <section className="onboarding-card" aria-label="Your onboarding progress">
      <div className="onboarding-card__progress">
        <div className="onboarding-card__track">
          <div className="onboarding-card__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="onboarding-card__label">
          {onboarding.stepsCompleted} of {onboarding.stepsTotal} steps complete
        </span>
      </div>
      {onboarding.kickoffScheduledAt !== null && (
        <p className="onboarding-card__kickoff">
          Your kickoff call is scheduled for{' '}
          <strong>{formatDateTime(onboarding.kickoffScheduledAt)}</strong>.
        </p>
      )}
      <ol className="onboarding-card__steps">
        {onboarding.steps.map((step) => (
          <StepItem key={step.stepKey} step={step} />
        ))}
      </ol>
    </section>
  );
}

function StepItem({ step }: { readonly step: ConciergeOnboardingStepRecord }): React.JSX.Element {
  const done = step.status === 'completed' || step.status === 'skipped';
  return (
    <li className={`onboarding-card__step onboarding-card__step--${done ? 'done' : 'pending'}`}>
      <span className="onboarding-card__step-mark" aria-hidden="true">
        {done ? '✓' : '○'}
      </span>
      <span className="onboarding-card__step-body">
        <span className="onboarding-card__step-title">{step.title}</span>
        <span className="onboarding-card__step-status">{labelFor(step.status)}</span>
      </span>
    </li>
  );
}

function labelFor(status: ConciergeOnboardingStepRecord['status']): string {
  if (status === 'completed') return 'Done';
  if (status === 'skipped') return 'Not needed';
  return 'Coming up';
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
    </main>
  );
}
