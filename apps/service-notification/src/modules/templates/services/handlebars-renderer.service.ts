import { Injectable, Logger } from '@nestjs/common';
import Handlebars from 'handlebars';

import type { RenderVariableValue } from '@taste-and-see/contracts';

/**
 * Handlebars renderer (TS-072; PDD §12.2 "MJML for email;
 * Handlebars/MJML hybrid").
 *
 * Wraps the `handlebars` library with hardened defaults so an admin-
 * authored template can't escape the variable-substitution context:
 *
 *   - Per-render isolated environment via `Handlebars.create()` — no
 *     shared helper registry across renders. A malicious template can't
 *     register a `{{#registerHelper}}` block that bleeds into a sibling
 *     render.
 *
 *   - `knownHelpersOnly: true` + empty `knownHelpers` map — every
 *     custom helper is locked out. Note: Handlebars' built-in block
 *     helpers (`{{#if}}`, `{{#each}}`, `{{#with}}`, `{{#unless}}`)
 *     are compile-time inlined and remain available; they're safe
 *     because variable validation upstream constrains every value
 *     to the JSON-safe primitives (string / number / boolean), so
 *     `{{#each}}` over a string iterates characters (low risk) and
 *     `{{#with}}` over a primitive narrows to the same value. The
 *     `lookup` helper (the only built-in capable of arbitrary
 *     property access) IS blocked because it's a regular helper, not
 *     a block helper.
 *
 *   - Prototype access blocked by default in Handlebars ≥ 4.6 (no
 *     `allowProtoPropertiesByDefault`, no `allowProtoMethodsByDefault`).
 *     We don't toggle either off.
 *
 *   - Different escape modes per field:
 *       * `bodyHtml`  — default HTML escaping (variables that contain
 *                       `<` / `&` / `"` render as `&lt;` etc.).
 *       * `bodyText`  — no escaping (the body is plain text; HTML-
 *                       escaping would render `&amp;` into the SMS).
 *       * `subject`   — no escaping (subject lines are plain text;
 *                       email clients display the raw value).
 *
 *   - Variable-resolution lookup is `undefined` for any key not in the
 *     supplied variables map (the VariableValidatorService rejects
 *     unknown keys before render — defence in depth).
 *
 * Compilation is fast (<1 ms typical); we re-compile per render rather
 * than caching because the variable-substitution surface is the hot
 * path, not the parse step. A `compileCache` lands as a follow-up if
 * the metric ever calls for it.
 *
 * **Result shape.** Returns `{ outcome: 'ok', output }` on success or
 * `{ outcome: 'failed', message }` on a template-parse failure. Never
 * throws — the caller maps `failed` to a 422.
 */
@Injectable()
export class HandlebarsRendererService {
  private readonly logger = new Logger(HandlebarsRendererService.name);

  /**
   * Render a single template string against the supplied variables.
   *
   * `escapeMode`:
   *   - `'html'` — HTML-escape every variable substitution (the
   *                default for `bodyHtml`).
   *   - `'text'` — no escaping (the default for `bodyText` / `subject`).
   */
  render(input: RenderInput): RenderResult {
    const env = Handlebars.create();
    const compiled = (() => {
      try {
        return env.compile(input.source, {
          noEscape: input.escapeMode === 'text',
          knownHelpersOnly: true,
          knownHelpers: {},
          strict: false,
        });
      } catch (err) {
        this.logger.debug(
          {
            err: err instanceof Error ? err.message : String(err),
          },
          'handlebars.compile.threw',
        );
        return null;
      }
    })();

    if (compiled === null) {
      return {
        outcome: 'failed',
        message: 'template source failed to parse as a Handlebars template',
      };
    }

    try {
      const output = compiled(input.variables, {
        // No helper data, no partials.
        helpers: {},
        partials: {},
        allowProtoPropertiesByDefault: false,
        allowProtoMethodsByDefault: false,
        allowedProtoProperties: {},
        allowedProtoMethods: {},
      });
      return { outcome: 'ok', output };
    } catch (err) {
      this.logger.debug(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        'handlebars.exec.threw',
      );
      return {
        outcome: 'failed',
        message: err instanceof Error ? err.message : 'handlebars template execution failed',
      };
    }
  }
}

export interface RenderInput {
  readonly source: string;
  readonly variables: Readonly<Record<string, RenderVariableValue>>;
  readonly escapeMode: 'html' | 'text';
}

export type RenderResult =
  | { readonly outcome: 'ok'; readonly output: string }
  | { readonly outcome: 'failed'; readonly message: string };
