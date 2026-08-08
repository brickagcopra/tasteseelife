import { describe, expect, it } from 'vitest';

import { portalSentryOptions } from './portal';
import { scrubBreadcrumb, scrubSentryEvent } from './scrub';

describe('portalSentryOptions', () => {
  it('tags the release with the portal name and version', () => {
    const options = portalSentryOptions({ portal: 'web-family', version: '1.4.2' });

    // The acceptance criterion of TS-504-followup-2a-1. Four portals deploy at
    // four independent versions, so a bare version string would attribute a
    // family-portal regression to whatever else shipped under that tag.
    expect(options.release).toBe('web-family@1.4.2');
    expect(options.initialScope.tags.service).toBe('web-family');
  });

  it('falls back to a named release rather than an empty one', () => {
    expect(portalSentryOptions({ portal: 'web-admin' }).release).toBe('web-admin@dev');
    expect(portalSentryOptions({ portal: 'web-admin', version: '' }).release).toBe('web-admin@dev');
  });

  it('treats an empty DSN as off, not as a DSN', () => {
    // The k8s Secret placeholder ships `SENTRY_DSN: ""`, so the empty string
    // reaches this function in every un-provisioned environment. Passing it
    // through would hand Sentry a DSN it cannot parse instead of leaving the
    // client disabled.
    expect(portalSentryOptions({ portal: 'web-provider', dsn: '' }).dsn).toBeUndefined();
    expect(portalSentryOptions({ portal: 'web-provider' }).dsn).toBeUndefined();
    expect(portalSentryOptions({ portal: 'web-provider', dsn: 'https://k@o.ingest/1' }).dsn).toBe(
      'https://k@o.ingest/1',
    );
  });

  it('defaults the environment rather than reporting an empty one', () => {
    expect(portalSentryOptions({ portal: 'web-marketing' }).environment).toBe('development');
    expect(
      portalSentryOptions({ portal: 'web-marketing', environment: 'staging' }).environment,
    ).toBe('staging');
  });

  it('sends no PII and no performance data', () => {
    const options = portalSentryOptions({ portal: 'web-family' });

    // Both are pinned as literal types AND asserted here. These portals render
    // a named senior's care schedule; `sendDefaultPii` would attach headers,
    // cookies and IPs, and a span's attributes carry full URLs containing
    // household and senior ids (§12, §17.2, PDD §16.3).
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
  });

  it('routes every event and breadcrumb through the shared scrubbers', () => {
    // The portals must not grow a second set of redaction rules — the platform
    // has exactly one PII list, derived from the logger's. Identity, not
    // behaviour: a re-implementation that happened to agree today would drift.
    const options = portalSentryOptions({ portal: 'web-family' });

    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(options.beforeBreadcrumb).toBe(scrubBreadcrumb);
  });

  it('rejects a portal name it could not tag with', () => {
    expect(() => portalSentryOptions({ portal: '' })).toThrow(/non-empty string/);
  });
});
