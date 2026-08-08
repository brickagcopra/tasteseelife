import {
  ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS,
  BulkRoleAssignmentRowSchema,
  type BulkRoleAssignmentRow,
} from '@taste-and-see/contracts';

/**
 * Minimal RFC-4180-ish CSV parsing for the bulk role-assignment sheet
 * (TS-292). Hand-rolled on purpose — no new library (CLAUDE.md §13);
 * the format is one fixed five-column header. Handles: UTF-8 BOM,
 * CRLF / LF line ends, quoted fields with `""` escapes, and blank
 * trailing lines. Anything fancier (embedded newlines inside quotes
 * are supported; multi-char delimiters are not) belongs to a real
 * import pipeline, not an ops CSV.
 */

export const BULK_CSV_HEADERS = [
  'userId',
  'roleName',
  'scopeType',
  'scopeId',
  'expiresAt',
] as const;

export type ParsedCsv =
  | { readonly kind: 'ok'; readonly rows: readonly BulkRoleAssignmentRow[] }
  | { readonly kind: 'error'; readonly message: string };

/** Split raw CSV text into rows of fields (quote-aware). */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      // Consume \r\n as one break.
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Final field / row (no trailing newline).
  row.push(field);
  rows.push(row);

  // Drop fully-blank rows (trailing newline artifacts).
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/**
 * Parse the uploaded sheet into contract rows. The header row is
 * required and must name exactly the five expected columns (any
 * order); empty cells become `null` for the nullable columns.
 * Per-cell SEMANTIC validation (does the user exist, is the date
 * future…) is the service's job — this only rejects structural
 * problems the wire schema would refuse.
 */
export function parseBulkAssignmentsCsv(text: string): ParsedCsv {
  const grid = splitCsv(text);
  if (grid.length === 0) {
    return { kind: 'error', message: 'The file is empty.' };
  }

  const headerRow = grid[0];
  if (headerRow === undefined) {
    return { kind: 'error', message: 'The file is empty.' };
  }
  const header = headerRow.map((h) => h.trim());
  const missing = BULK_CSV_HEADERS.filter((expected) => !header.includes(expected));
  if (missing.length > 0) {
    return {
      kind: 'error',
      message: `Missing column header(s): ${missing.join(', ')}. Expected exactly: ${BULK_CSV_HEADERS.join(', ')}.`,
    };
  }
  const extra = header.filter((h) => !(BULK_CSV_HEADERS as readonly string[]).includes(h));
  if (extra.length > 0) {
    return {
      kind: 'error',
      message: `Unknown column header(s): ${extra.join(', ')}. Expected exactly: ${BULK_CSV_HEADERS.join(', ')}.`,
    };
  }
  const indexOf = Object.fromEntries(BULK_CSV_HEADERS.map((h) => [h, header.indexOf(h)])) as Record<
    (typeof BULK_CSV_HEADERS)[number],
    number
  >;

  const dataRows = grid.slice(1);
  if (dataRows.length === 0) {
    return { kind: 'error', message: 'No data rows found under the header.' };
  }
  if (dataRows.length > ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS) {
    return {
      kind: 'error',
      message: `Too many rows (${dataRows.length}) — the limit is ${ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS} per file. Split the sheet and run the batches separately.`,
    };
  }

  const rows: BulkRoleAssignmentRow[] = [];
  for (const [lineIndex, cells] of dataRows.entries()) {
    const cell = (name: (typeof BULK_CSV_HEADERS)[number]): string =>
      (cells[indexOf[name]] ?? '').trim();
    const candidate = {
      userId: cell('userId'),
      roleName: cell('roleName'),
      scopeType: cell('scopeType'),
      scopeId: cell('scopeId').length === 0 ? null : cell('scopeId'),
      expiresAt: cell('expiresAt').length === 0 ? null : cell('expiresAt'),
    };
    const parsed = BulkRoleAssignmentRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'error',
        message: `Row ${lineIndex + 2} (line ${lineIndex + 2}) is malformed: ${issue?.path.join('.') ?? 'row'} — ${issue?.message ?? 'invalid'}.`,
      };
    }
    rows.push(parsed.data);
  }

  return { kind: 'ok', rows };
}
