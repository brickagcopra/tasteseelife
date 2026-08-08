import { Logger } from '@nestjs/common';
import { getSentryStatus } from '@taste-and-see/sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SentryStatusReporter } from './sentry-status.reporter';

vi.mock('@taste-and-see/sentry/node', () => ({ getSentryStatus: vi.fn() }));

const statusMock = vi.mocked(getSentryStatus);

/**
 * The reporter exists so that "Sentry is off" is a thing somebody can read in
 * the logs. So the assertions are about LEVEL — a WARN nobody would see and a
 * WARN on every developer boot are both failures, in opposite directions.
 */
describe('SentryStatusReporter', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
  });

  function report(serviceName = 'service-identity'): void {
    new SentryStatusReporter(serviceName).onApplicationBootstrap();
  }

  it('logs the release at info when Sentry is enabled', () => {
    statusMock.mockReturnValue({ enabled: true, release: 'service-identity@1.2.3' });
    process.env['NODE_ENV'] = 'production';

    report();

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toEqual({
      service: 'service-identity',
      release: 'service-identity@1.2.3',
    });
  });

  it('WARNS outside development when reporting is off — that state is the outage', () => {
    statusMock.mockReturnValue({ enabled: false, reason: 'no_dsn' });
    process.env['NODE_ENV'] = 'production';

    report('service-booking');

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ service: 'service-booking', reason: 'no_dsn' });
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/not being reported anywhere/);
  });

  it('does NOT warn in development, where no DSN is the expected state', () => {
    // A warning on every local boot is noise that teaches people to skip
    // warnings — which costs us the production case above.
    statusMock.mockReturnValue({ enabled: false, reason: 'no_dsn' });
    process.env['NODE_ENV'] = 'development';

    report();

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not warn in test either', () => {
    statusMock.mockReturnValue({ enabled: false, reason: 'disabled' });
    process.env['NODE_ENV'] = 'test';

    report();

    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an unset NODE_ENV as development', () => {
    statusMock.mockReturnValue({ enabled: false, reason: 'no_dsn' });
    delete process.env['NODE_ENV'];

    report();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns in staging, not just production', () => {
    // `NODE_ENV !== 'production'` would have let staging run unreported.
    statusMock.mockReturnValue({ enabled: false, reason: 'no_dsn' });
    process.env['NODE_ENV'] = 'staging';

    report();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when the bootstrap never ran, in every environment', () => {
    // `undefined` means main.ts did not import the first-line shim — which
    // costs traces and metrics too, not just Sentry.
    statusMock.mockReturnValue(undefined);
    process.env['NODE_ENV'] = 'development';

    report();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/bootstrap did not run/);
  });
});
