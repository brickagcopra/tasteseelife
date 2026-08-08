/**
 * RFC 7807 problem-detail extraction for admin surfaces (TS-303c2b).
 *
 * Most admin server actions collapse a downstream failure into a short code
 * (`?action=err&code=conflict`) and render a generic sentence. That is right
 * when the failure is a shape error the operator cannot act on. It is wrong on
 * the mandated-reporter surface, where the downstream 409s and 422s ARE the
 * operator's explanation and were written for them:
 *
 *   "the mandated-reporter kit for 'NY' has not been verified by compliance;
 *    filing preparation is blocked until it is"
 *   "reviewer signoff must be performed by someone other than the operator who
 *    opened the case"
 *
 * The gateway proxy forwards those bodies verbatim precisely so a console can
 * show them (see its `client_error` case). Flattening them to "Something went
 * wrong (conflict)" would tell an operator working an elder-abuse deadline
 * nothing about what to do next.
 *
 * Safety properties, since this puts downstream text into a URL and then onto
 * a page:
 *   - Length-capped, so a pathological body cannot blow the query string.
 *   - Control characters stripped, so nothing can smuggle a line break into a
 *     redirect header.
 *   - Rendered as TEXT by React (never `dangerouslySetInnerHTML`), so markup
 *     in the string is escaped, not executed.
 *   - Returns null for anything that is not a plain non-empty `detail` string,
 *     so the caller falls back to its generic message rather than rendering
 *     `[object Object]`.
 *
 * NOT for PHI-bearing text. The details on this surface name a state code, a
 * status, and a rule; none quote a case's `determinationNotes`. A downstream
 * that started echoing free text into a problem `detail` would need this
 * revisited (CLAUDE.md §3.9).
 */

/**
 * Cap on the forwarded explanation. Long enough for every detail the
 * mandated-reporter service produces, short enough to stay a sane query param.
 */
export const PROBLEM_DETAIL_MAX_LENGTH = 300;

/**
 * Drop C0/C1 control characters and collapse runs of whitespace. Done by code
 * point rather than by regex literal so the source file stays plain ASCII —
 * a regex holding raw control bytes is unreadable and easy to corrupt in an
 * edit.
 */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Pull a renderable `detail` out of an `ApiResult` body. Returns null when the
 * body is not an RFC 7807 problem with a usable string detail.
 */
export function readProblemDetail(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const detail = (body as Record<string, unknown>)['detail'];
  if (typeof detail !== 'string') return null;
  const cleaned = stripControlCharacters(detail);
  if (cleaned.length === 0) return null;
  return cleaned.length > PROBLEM_DETAIL_MAX_LENGTH
    ? `${cleaned.slice(0, PROBLEM_DETAIL_MAX_LENGTH - 1)}…`
    : cleaned;
}

/**
 * `&detail=…` suffix for an error redirect, or the empty string when there is
 * nothing worth forwarding. Encoded here so callers cannot forget to.
 */
export function problemDetailParam(body: unknown): string {
  const detail = readProblemDetail(body);
  return detail === null ? '' : `&detail=${encodeURIComponent(detail)}`;
}

/**
 * Read a forwarded detail back off `searchParams`, applying the same cap and
 * control-character strip — the query string is user-editable, so the value
 * coming back is not trusted just because we put it there.
 */
export function readDetailParam(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  const raw = search['detail'];
  if (typeof raw !== 'string') return null;
  return readProblemDetail({ detail: raw });
}
