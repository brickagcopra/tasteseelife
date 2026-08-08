/**
 * Shape of an outbox row read by the relay. Mirrors the column shape
 * every service's `{schema}.outbox_events` table ships (see
 * `packages/nest-outbox/README.md` + the per-service migration).
 *
 * The relay is schema-agnostic — it reads the same five columns
 * regardless of which producer service the row came from. Schema +
 * table are tracked alongside so the relay's logs and metrics can
 * attribute failures to the right source.
 */
export interface OutboxRow {
  readonly schema: string;
  readonly table: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly producerService: string;
  readonly attempts: number;
  readonly createdAt: Date;
}

/**
 * Per-source poll outcome. Surface for tests and metrics.
 */
export interface RelayPollResult {
  readonly source: string;
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly deadLettered: number;
}
