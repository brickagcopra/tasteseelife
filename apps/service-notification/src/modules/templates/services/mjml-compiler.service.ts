import { Injectable, Logger } from '@nestjs/common';
import mjml2html from 'mjml';

/**
 * MJML → HTML compiler (TS-072; PDD §12.2 "MJML for email").
 *
 * Wraps the `mjml` library with hardened defaults:
 *
 *   - `ignoreIncludes: true` — disables the `<mj-include path="...">`
 *     tag so an admin-authored template can't read a path off the
 *     local filesystem at compile time. Critical for defence-in-depth
 *     in a multi-tenant template authoring environment (PRD §10.15
 *     "multi-author collaboration with role-based permissions").
 *
 *   - `validationLevel: 'strict'` — surfaces every MJML schema
 *     violation as a compilation failure rather than silently
 *     producing semi-rendered output.
 *
 *   - `keepComments: false` — strips HTML comments from the compiled
 *     output. Smaller payload, no information leakage about the
 *     authoring environment.
 *
 *   - `minify: false` — keep the compiled HTML pretty-printed. Email
 *     clients render either way; debugging is materially easier when
 *     the compiled output is human-readable.
 *
 * Compilation is synchronous and CPU-bound. Typical template lands
 * at < 50 ms; the worst-case "every brand attribute every section"
 * email lands at ~200 ms. We run inside the HTTP handler today (TS-072
 * version-create path); if compile latency ever drives a P95 above
 * the CLAUDE.md §7.1 budget, offload to a BullMQ worker — captured as
 * TS-072-followup-2's sibling.
 *
 * **Result shape.** Returns a typed `MjmlCompileResult` discriminated
 * union — `{ outcome: 'ok', html }` on success, `{ outcome: 'failed',
 * errors }` on validation failure. Never throws; the caller turns
 * `failed` into a 422 at the service layer.
 */
@Injectable()
export class MjmlCompilerService {
  private readonly logger = new Logger(MjmlCompilerService.name);

  /**
   * Compile MJML source into an HTML email payload.
   *
   * Errors are returned in the result, not thrown — the controller
   * surface maps them to a 422 `Unprocessable Entity` with the parser
   * messages in the RFC 7807 body so the admin can fix the template.
   */
  compile(mjmlSource: string): MjmlCompileResult {
    try {
      const compiled = mjml2html(mjmlSource, {
        ignoreIncludes: true,
        validationLevel: 'strict',
        keepComments: false,
        minify: false,
      });

      // `compiled.errors` is populated even for non-fatal warnings under
      // `validationLevel: 'strict'`. Anything in the list is a fail.
      if (compiled.errors.length > 0) {
        return {
          outcome: 'failed',
          errors: compiled.errors.map((error) => ({
            line: typeof error.line === 'number' ? error.line : null,
            tagName: typeof error.tagName === 'string' ? error.tagName : null,
            message: typeof error.message === 'string' ? error.message : 'unknown mjml error',
          })),
        };
      }

      return {
        outcome: 'ok',
        html: compiled.html,
      };
    } catch (err) {
      // mjml's strict mode throws on syntactically broken input
      // (e.g. an unclosed tag). Convert into the failed shape so the
      // controller surface stays uniform.
      this.logger.debug(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        'mjml.compile.threw',
      );
      return {
        outcome: 'failed',
        errors: [
          {
            line: null,
            tagName: null,
            message: err instanceof Error ? err.message : 'mjml compilation threw',
          },
        ],
      };
    }
  }
}

/**
 * Discriminated-union result of a single MJML compilation. The renderer
 * never throws on bad input — the failed outcome carries enough detail
 * for the admin UI to point at the offending tag.
 */
export type MjmlCompileResult =
  | { readonly outcome: 'ok'; readonly html: string }
  | { readonly outcome: 'failed'; readonly errors: readonly MjmlCompileError[] };

export interface MjmlCompileError {
  readonly line: number | null;
  readonly tagName: string | null;
  readonly message: string;
}
