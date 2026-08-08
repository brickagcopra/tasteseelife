import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetSentryForTests, captureException, initSentry, shutdownSentry } from './node';
import { REDACTION_CENSOR } from './redaction';

// Only the client lifecycle is faked. The integration factories stay REAL so
// the exclusion assertions below read the names the SDK actually produces —
// a hand-written list of fake names would keep passing after an SDK rename,
// which is precisely when the "no instrumentation integrations" rule needs to
// be re-checked.
vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...actual,
    init: vi.fn(),
    close: vi.fn(async () => true),
    captureException: vi.fn(),
    getGlobalScope: vi.fn(() => ({ addEventProcessor: vi.fn() })),
  };
});

const initMock = vi.mocked(Sentry.init);

function lastInitOptions(): Sentry.NodeOptions {
  const call = initMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('Sentry.init was never called');
  return call[0] as Sentry.NodeOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSentryForTests();
  delete process.env['SENTRY_DSN'];
});

afterEach(() => {
  __resetSentryForTests();
  delete process.env['SENTRY_DSN'];
});

describe('initSentry — configuration outcome is reported, never silent', () => {
  it('stays off and SAYS SO when no DSN is configured', () => {
    // The failure mode this whole result type exists to prevent: an
    // unconfigured error tracker is indistinguishable from a healthy one
    // from the inside (cf. TS-306-followup-1c's no-op meter). The caller
    // logs `no_dsn`; without it, nothing anywhere reports the outage.
    expect(initSentry({ service: 'service-identity' })).toEqual({
      enabled: false,
      reason: 'no_dsn',
    });
    expect(initMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string DSN as absent', () => {
    process.env['SENTRY_DSN'] = '';
    expect(initSentry({ service: 'service-identity' })).toEqual({
      enabled: false,
      reason: 'no_dsn',
    });
    expect(initMock).not.toHaveBeenCalled();
  });

  it('distinguishes deliberately disabled from unconfigured', () => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    expect(initSentry({ service: 'service-identity', enabled: false })).toEqual({
      enabled: false,
      reason: 'disabled',
    });
    expect(initMock).not.toHaveBeenCalled();
  });

  it('rejects an empty service name rather than tagging events with nothing', () => {
    expect(() => initSentry({ service: '' })).toThrow(/non-empty string/);
  });

  it('does not re-init on a second call — a duplicate init silently swaps the client mid-flight', () => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
    initSentry({ service: 'service-identity', version: '1.0.0' });
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});

describe('initSentry — release tagging (CLAUDE.md §10)', () => {
  beforeEach(() => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
  });

  it('qualifies the release with the service name', () => {
    // 24 workloads deploy at independent versions; a bare version string
    // would attribute a booking regression to whatever else shipped that tag.
    const result = initSentry({ service: 'service-booking', version: '1.4.2' });
    expect(result).toEqual({ enabled: true, release: 'service-booking@1.4.2' });
    expect(lastInitOptions().release).toBe('service-booking@1.4.2');
  });

  it('falls back to SERVICE_VERSION then dev, matching the observability bootstrap', () => {
    initSentry({ service: 'service-booking' });
    expect(lastInitOptions().release).toBe('service-booking@dev');
  });

  it('tags every event with the service', () => {
    initSentry({ service: 'service-booking', version: '1.0.0' });
    expect(lastInitOptions().initialScope).toEqual({ tags: { service: 'service-booking' } });
  });
});

describe('initSentry — must not contend with @taste-and-see/tracing for OpenTelemetry', () => {
  beforeEach(() => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
  });

  it('skips OpenTelemetry setup so the tracing package keeps ownership of the provider', () => {
    expect(lastInitOptions().skipOpenTelemetrySetup).toBe(true);
  });

  it('opts out of the default integrations wholesale', () => {
    expect(lastInitOptions().defaultIntegrations).toBe(false);
  });

  it('enables NO instrumentation integration', () => {
    // Each of these patches a module `@opentelemetry/auto-instrumentations-node`
    // already patches. Two SDKs on one module is double spans and a contested
    // context manager, not a merge.
    const names = (lastInitOptions().integrations as ReadonlyArray<{ name: string }>).map(
      (i) => i.name,
    );
    for (const banned of [
      'Http',
      'Express',
      'Prisma',
      'Postgres',
      'Redis',
      'NodeFetch',
      'Graphql',
      'Kafka',
    ]) {
      expect(names, `${banned} integration must not be enabled`).not.toContain(banned);
    }
  });

  it('does not request performance sampling', () => {
    expect(lastInitOptions().tracesSampleRate).toBeUndefined();
  });
});

describe('initSentry — PII posture (CLAUDE.md §3.9, §17.2)', () => {
  beforeEach(() => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
  });

  it('sets sendDefaultPii explicitly rather than trusting the SDK default', () => {
    // A default that flips in a major version would be a silent PII
    // regression with no diff to review.
    expect(lastInitOptions().sendDefaultPii).toBe(false);
  });

  it('never enables localVariables, which would ship the throwing frame’s plaintext', () => {
    // In a login handler the locals are the password. The scrubber censors
    // the well-named ones, but a variable called `p` is not well named and
    // §17.2 is not a best-effort rule.
    const names = (lastInitOptions().integrations as ReadonlyArray<{ name: string }>).map(
      (i) => i.name,
    );
    expect(names).not.toContain('LocalVariables');
  });

  it('never enables console capture, which would bypass the logger redaction layer', () => {
    const names = (lastInitOptions().integrations as ReadonlyArray<{ name: string }>).map(
      (i) => i.name,
    );
    expect(names).not.toContain('Console');
    expect(names).not.toContain('CaptureConsole');
  });

  it('routes every event through the scrubber', () => {
    const beforeSend = lastInitOptions().beforeSend;
    expect(beforeSend).toBeTypeOf('function');
    const scrubbed = beforeSend?.(
      { type: undefined, request: { data: { password: 'hunter2' } } },
      {},
    ) as Sentry.Event;
    expect((scrubbed.request?.data as Record<string, unknown>)['password']).toBe(REDACTION_CENSOR);
  });

  it('routes every breadcrumb through the scrubber', () => {
    const beforeBreadcrumb = lastInitOptions().beforeBreadcrumb;
    expect(beforeBreadcrumb).toBeTypeOf('function');
    const crumb = beforeBreadcrumb?.({ data: { apiKey: 'k' } }, {});
    expect((crumb?.data as Record<string, unknown>)['apiKey']).toBe(REDACTION_CENSOR);
  });
});

describe('initSentry — the process-level catchers are the point of the package', () => {
  it('enables uncaught exception and unhandled rejection handling', () => {
    // Nest’s RfcProblemFilter covers everything inside a request. These two
    // cover what happens outside one: a BullMQ processor, an outbox consumer
    // tick, a floating promise.
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-booking', version: '1.0.0' });
    const names = (lastInitOptions().integrations as ReadonlyArray<{ name: string }>).map(
      (i) => i.name,
    );
    expect(names).toContain('OnUncaughtException');
    expect(names).toContain('OnUnhandledRejection');
    expect(names).toContain('LinkedErrors');
  });
});

describe('captureException', () => {
  it('no-ops when Sentry was never initialised, so call sites need no config check', () => {
    captureException(new Error('boom'));
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it('forwards the error once initialised', () => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
    const err = new Error('boom');
    captureException(err, { bookingId: 'bk_1' });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(err, {
      extra: { bookingId: 'bk_1' },
    });
  });

  it('puts caller context in `extra`, which beforeSend scrubs like everything else', () => {
    // A caller must not be able to opt out of redaction by choosing this
    // parameter — `extra` is walked by the same rules.
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
    captureException(new Error('boom'), { password: 'hunter2' });
    const [, hint] = vi.mocked(Sentry.captureException).mock.calls[0] ?? [];
    const scrubbed = lastInitOptions().beforeSend?.(
      { type: undefined, extra: (hint as { extra: Record<string, unknown> }).extra },
      {},
    ) as Sentry.Event;
    expect((scrubbed.extra as Record<string, unknown>)['password']).toBe(REDACTION_CENSOR);
  });
});

describe('shutdownSentry', () => {
  it('is a no-op when never initialised', async () => {
    await shutdownSentry();
    expect(vi.mocked(Sentry.close)).not.toHaveBeenCalled();
  });

  it('flushes with a bounded timeout so a Sentry outage cannot hold a pod terminating', async () => {
    process.env['SENTRY_DSN'] = 'https://k@o.ingest.test/1';
    initSentry({ service: 'service-identity', version: '1.0.0' });
    await shutdownSentry();
    expect(vi.mocked(Sentry.close)).toHaveBeenCalledWith(2_000);
  });
});
