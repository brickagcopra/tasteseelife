/**
 * DI token for the validated PagerDuty module options.
 *
 * Exported as a symbol so a host application can resolve the configured
 * options, or override them in tests via
 * `Test.createTestingModule(...).overrideProvider(PAGERDUTY_OPTIONS_TOKEN)`.
 */
export const PAGERDUTY_OPTIONS_TOKEN = Symbol.for('@taste-and-see/nest-pagerduty:options');
