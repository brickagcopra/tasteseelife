import PDFDocument from 'pdfkit';

import type { AcademyCourseTrack } from '@taste-and-see/contracts';

/**
 * Certificate PDF rendering (TS-255; PRD §9.3 "Verifiable certificates (PDF +
 * on-platform badge)"; PDD §15.2). Pure, side-effect-free: it takes the facts
 * captured at issue time and returns the rendered PDF bytes. Storage (S3) is a
 * separate concern (`certificate-pdf-store.ts`); cross-service reads are never
 * performed here — every fact is snapshotted by the caller.
 *
 * `pdfkit` is on the approved-libraries list (CLAUDE.md §13). We render with the
 * library's built-in standard fonts (Helvetica family) so the worker image
 * needs no font assets bundled.
 *
 * The verification URL is printed verbatim so a holder (or a third party) can
 * type it in to confirm authenticity; the token is also the only thing the
 * public verification page keys on.
 */

/** Human-readable track labels for the certificate body (presentation only). */
const TRACK_LABELS: Readonly<Record<AcademyCourseTrack, string>> = {
  general: 'General',
  dementia_sensitive: 'Dementia-Sensitive Dining',
  therapeutic_meals: 'Therapeutic Meals',
  luxury_in_home: 'Luxury In-Home Service',
  cultural_comfort_cuisine: 'Cultural Comfort Cuisine',
};

export interface CertificateFacts {
  readonly holderName: string;
  readonly courseTitle: string;
  readonly track: AcademyCourseTrack;
  /** ISO-8601 issue date. */
  readonly issuedAt: string;
  /** ISO-8601 expiry, or null when the certification does not expire. */
  readonly expiresAt: string | null;
  /** The public verification token (printed + the URL key). */
  readonly verificationToken: string;
  /** The absolute `/verify/cert/{token}` URL printed on the certificate. */
  readonly verificationUrl: string;
}

/** Format an ISO timestamp as a plain `D Month YYYY` (UTC) for the certificate body. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Render the certificate to a PDF buffer. Resolves once the document's writable
 * stream has fully flushed (pdfkit emits `data` chunks then `end`).
 */
export function renderCertificatePdf(facts: CertificateFacts): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margins: { top: 64, bottom: 64, left: 72, right: 72 },
      info: {
        Title: `Taste & See — Certificate of Completion`,
        Author: 'Taste & See Cooking Academy',
        Subject: facts.courseTitle,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const centered = { width: pageWidth, align: 'center' as const };

    doc
      .font('Helvetica-Bold')
      .fontSize(26)
      .text('Taste & See Cooking Academy', centered)
      .moveDown(0.3)
      .font('Helvetica')
      .fontSize(14)
      .text('Certificate of Completion', centered)
      .moveDown(1.5);

    doc.fontSize(12).text('This certifies that', centered).moveDown(0.5);

    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .text(facts.holderName, centered)
      .moveDown(0.6)
      .font('Helvetica')
      .fontSize(12)
      .text('has successfully completed', centered)
      .moveDown(0.5);

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(facts.courseTitle, centered)
      .moveDown(0.3)
      .font('Helvetica')
      .fontSize(12)
      .text(`Specialty track: ${TRACK_LABELS[facts.track]}`, centered)
      .moveDown(1.5);

    const issued = `Issued ${formatDate(facts.issuedAt)}`;
    const expiry =
      facts.expiresAt === null ? '' : `   ·   Valid through ${formatDate(facts.expiresAt)}`;
    doc.fontSize(11).text(`${issued}${expiry}`, centered).moveDown(1.5);

    doc
      .fontSize(9)
      .fillColor('#555555')
      .text('Verify this certificate at', centered)
      .font('Helvetica-Bold')
      .text(facts.verificationUrl, centered)
      .font('Helvetica')
      .text(`Verification code: ${facts.verificationToken}`, centered)
      .fillColor('black');

    doc.end();
  });
}
