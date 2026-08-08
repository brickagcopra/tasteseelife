/**
 * In-memory Prisma fake for the incidents unit tests (TS-300). Implements
 * only the narrow surface `IncidentRepository` consumes:
 * `incident.{create,findUnique}` with explicit `select` projection. Real
 * enum/constraint behaviour and the tenant-scope gate are covered by the
 * Testcontainers integration suite (a carried TS-300 followup). Excluded
 * from build + coverage globs (`__fixtures__/`).
 */

type Row = Record<string, unknown>;

/** A Prisma `select`: scalars as booleans, relations as nested selects. */
type SelectShape = Record<string, boolean | { select: Record<string, boolean> }>;

/** Monotonic clock — strictly-increasing `createdAt` without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 6, 2, 0, 0, tick));
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (select === undefined) {
    return { ...row };
  }
  const projected: Row = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) {
      projected[field] = row[field];
    }
  }
  return projected;
}

export class FakeIncidentsPrisma {
  rows: Row[] = [];
  /**
   * Incident ids that have a mandated-reporter case (TS-303c2d). The read
   * paths project the one-to-one relation down to `{ id }` and only ever ask
   * whether it is null, so a set of ids models it exactly.
   */
  mandatedReporterCaseIncidentIds = new Set<string>();
  private counter = 0;

  /**
   * Naive `$transaction` (TS-301a): runs the callback against this same
   * fake and restores the row set if it throws — enough to assert
   * "an outbox-emit failure leaves no incident behind" at the unit level.
   * Real rollback semantics are Postgres's job (the Testcontainers
   * integration followup).
   *
   * The snapshot COPIES each row, not just the array (TS-303b). With a
   * shallow `[...this.rows]` an insert rolled back correctly — the element
   * disappeared — but an in-place UPDATE survived, because the restored
   * array still pointed at the mutated object. That made the
   * "audit-emit failure rolls the closure back" assertion pass vacuously in
   * the wrong direction.
   */
  async $transaction<T>(fn: (tx: FakeIncidentsPrisma) => Promise<T>): Promise<T> {
    const snapshot = this.rows.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (err) {
      this.rows = snapshot;
      throw err;
    }
  }

  readonly incident = {
    create: ({ data, select }: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      this.counter += 1;
      const row: Row = {
        id: `inc_${this.counter}`,
        householdId: null,
        seniorId: null,
        providerId: null,
        status: 'open',
        resolvedAt: null,
        resolutionNotes: null,
        sourceEventId: null,
        detector: null,
        systemFacts: null,
        createdAt: nextDate(),
        updatedAt: nextDate(),
        ...data,
      };
      this.rows.push(row);
      return Promise.resolve(project(row, select));
    },

    findUnique: ({
      where,
      select,
    }: {
      where: { id: string };
      select?: SelectShape;
    }): Promise<Row | null> => {
      const row = this.rows.find((candidate) => candidate['id'] === where.id);
      return Promise.resolve(row === undefined ? null : this.projectRow(row, select));
    },

    /**
     * Queue read (TS-303c2d). Models the two behaviours the repository relies
     * on: the `status: { not: 'resolved' }` default filter alongside the
     * optional equality filters, and the `slaDueAt` ASC → `openedAt` ASC
     * ordering.
     */
    findMany: ({
      where,
      take,
      select,
    }: {
      where?: {
        status?: string | { not: string };
        severity?: string;
        category?: string;
        householdId?: string;
        seniorId?: string;
        providerId?: string;
      };
      orderBy?: unknown;
      take?: number;
      select?: SelectShape;
    }): Promise<Row[]> => {
      const rows = this.rows
        .filter((row) => {
          const status = where?.status;
          if (status !== undefined) {
            if (typeof status === 'string') {
              if (row['status'] !== status) return false;
            } else if (row['status'] === status.not) {
              return false;
            }
          }
          for (const key of [
            'severity',
            'category',
            'householdId',
            'seniorId',
            'providerId',
          ] as const) {
            const wanted = where?.[key];
            if (wanted !== undefined && row[key] !== wanted) return false;
          }
          return true;
        })
        .sort((a, b) => {
          const slaA = (a['slaDueAt'] as Date).getTime();
          const slaB = (b['slaDueAt'] as Date).getTime();
          if (slaA !== slaB) return slaA - slaB;
          return (a['openedAt'] as Date).getTime() - (b['openedAt'] as Date).getTime();
        });
      const limited = take === undefined ? rows : rows.slice(0, take);
      return Promise.resolve(limited.map((row) => this.projectRow(row, select)));
    },

    /**
     * Compare-and-swap surface for the TS-303b resolution path. Only the
     * `status: { not: 'resolved' }` predicate the repository actually uses is
     * modelled — enough to drive "the second resolve loses" without pretending
     * to be a Prisma query engine.
     */
    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; status?: { not: string } };
      data: Row;
    }): Promise<{ count: number }> => {
      const row = this.rows.find((candidate) => candidate['id'] === where.id);
      if (row === undefined) return Promise.resolve({ count: 0 });
      if (where.status !== undefined && row['status'] === where.status.not) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, data, { updatedAt: nextDate() });
      return Promise.resolve({ count: 1 });
    },
  };

  /**
   * `project` plus the one-to-one `mandatedReporterCase` relation, which the
   * read paths select as `{ select: { id: true } }` and test only for
   * null-ness.
   */
  private projectRow(row: Row, select: SelectShape | undefined): Row {
    const scalarSelect =
      select === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(select).filter(([, value]) => typeof value === 'boolean'),
          );
    const projected = project(row, scalarSelect as Record<string, boolean> | undefined);
    if (select !== undefined && 'mandatedReporterCase' in select) {
      const id = row['id'] as string;
      projected['mandatedReporterCase'] = this.mandatedReporterCaseIncidentIds.has(id)
        ? { id: `mrc_for_${id}` }
        : null;
    }
    return projected;
  }
}
