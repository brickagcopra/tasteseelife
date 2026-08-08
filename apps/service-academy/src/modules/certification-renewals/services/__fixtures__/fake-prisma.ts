/**
 * Focused in-memory Prisma fake for the certification-renewals service unit
 * tests (TS-256).
 *
 * The shared catalog `FakeTable` only matches flat scalar / `in` where
 * clauses; the renewals service issues operator clauses the catalog fake
 * can't evaluate — `expiresAt: { not: null, lte: Date }` and
 * `id: { gt: cursor }`. So this fake implements exactly the narrow surface
 * `CertificationRenewalsService` consumes (`findMany` with those operators,
 * `findFirst` by id, `update`). The real index / FK / cascade behaviour is
 * the Testcontainers follow-up (TS-256-followup-3); this fake pins the
 * service's branching + keyset pagination. Excluded from build + coverage
 * globs (it lives under `__fixtures__/`).
 */

type Row = Record<string, unknown>;

interface CertRow extends Row {
  id: string;
  studentUserId: string;
  holderName: string | null;
  courseId: string;
  title: string;
  track: string;
  status: string;
  issuedAt: Date;
  expiresAt: Date | null;
}

interface WhereClause {
  status?: string;
  expiresAt?: { not?: null; lte?: Date };
  id?: { gt?: string };
}

function matches(row: CertRow, where: WhereClause | undefined): boolean {
  if (where === undefined) return true;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.expiresAt !== undefined) {
    if (where.expiresAt.not === null && row.expiresAt === null) return false;
    if (where.expiresAt.lte !== undefined) {
      if (row.expiresAt === null) return false;
      if (row.expiresAt.getTime() > where.expiresAt.lte.getTime()) return false;
    }
  }
  if (where.id?.gt !== undefined && !(row.id > where.id.gt)) return false;
  return true;
}

export class FakeCertificationRenewalsPrisma {
  private rows: CertRow[] = [];

  /** Seed a fully-formed certification row (test setup). */
  seed(row: CertRow): CertRow {
    this.rows.push(row);
    return row;
  }

  readonly academyCertification = {
    findMany: async (args: {
      where?: WhereClause;
      orderBy?: { id: 'asc' | 'desc' };
      take?: number;
    }): Promise<CertRow[]> => {
      let result = this.rows.filter((r) => matches(r, args.where));
      const dir = args.orderBy?.id ?? 'asc';
      result = [...result].sort((a, b) =>
        dir === 'desc' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id),
      );
      if (typeof args.take === 'number') result = result.slice(0, args.take);
      return result;
    },

    findFirst: async (args: { where: { id: string } }): Promise<CertRow | null> => {
      return this.rows.find((r) => r.id === args.where.id) ?? null;
    },

    update: async (args: { where: { id: string }; data: Row }): Promise<CertRow> => {
      const row = this.rows.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error(`cert ${args.where.id} not found`);
      Object.assign(row, args.data);
      return row;
    },
  };
}
