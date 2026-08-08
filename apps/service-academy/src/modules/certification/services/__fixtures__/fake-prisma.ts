/**
 * In-memory Prisma fake for the certification service unit tests (TS-255).
 *
 * Reuses the shared `FakeTable` (the catalog fixtures) and composes the tables
 * the `CertificationService` touches: `academyCourse` (the issued-from course),
 * `academyEnrollment` (the optional completion check), and `academyCertification`
 * (the issued record). The `academyCertification` defaults supply the nullable
 * columns the create path omits (`certificatePdfKey` / `revokedAt`) so the record
 * mapper's `?.toISOString()` projections always read a Date-or-null. The real FK
 * / cascade / `text[]` behaviour is the Testcontainers follow-up (TS-255-followup-3);
 * this fake pins the service branching. Excluded from build + coverage globs.
 */
import { FakeTable } from '../../../catalog/services/__fixtures__/fake-prisma';

export class FakeAcademyCertificationPrisma {
  readonly academyCourse = new FakeTable('course', { deletedAt: null });
  readonly academyEnrollment = new FakeTable('enrollment', { deletedAt: null });
  readonly academyCertification = new FakeTable('cert', {
    certificatePdfKey: null,
    revokedAt: null,
  });
}
