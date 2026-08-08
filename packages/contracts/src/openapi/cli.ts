import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateOpenApiDocument } from './generate';

/**
 * Path to the committed OpenAPI artifact, relative to the compiled CLI:
 * `<package>/dist/openapi/cli.js` → `<package>/generated/openapi.json`.
 *
 * The artifact is committed so contract drift is a PR diff signal, not a
 * runtime-only check. Run `pnpm -F @taste-and-see/contracts generate:openapi`
 * after schema edits to regenerate it.
 */
const ARTIFACT_PATH = resolve(__dirname, '../../generated/openapi.json');

const USAGE = [
  'Usage: contracts-cli <command>',
  '',
  'Commands:',
  '  write   Generate the OpenAPI document and overwrite generated/openapi.json',
  '  check   Generate the OpenAPI document and exit 1 if it drifts from the committed artifact',
].join('\n');

export function main(args: readonly string[]): number {
  const command = args[0];

  if (command === 'write') {
    writeFileSync(ARTIFACT_PATH, serialize(generateOpenApiDocument()), 'utf8');
    process.stdout.write(`wrote ${ARTIFACT_PATH}\n`);
    return 0;
  }

  if (command === 'check') {
    const fresh = serialize(generateOpenApiDocument());
    let committed: string;
    try {
      committed = readFileSync(ARTIFACT_PATH, 'utf8');
    } catch {
      process.stderr.write(
        `contract-check: artifact missing at ${ARTIFACT_PATH}\n` +
          '  run `pnpm -F @taste-and-see/contracts generate:openapi`, then commit the result.\n',
      );
      return 2;
    }
    if (committed === fresh) {
      process.stdout.write('contract-check: in sync\n');
      return 0;
    }
    process.stderr.write(
      'contract-check: drift detected.\n' +
        '  run `pnpm -F @taste-and-see/contracts generate:openapi` and commit the regenerated artifact.\n',
    );
    return 1;
  }

  process.stderr.write(`${USAGE}\n`);
  return 64;
}

function serialize(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// eslint-disable-next-line no-undef
if (require.main === module) {
  const exitCode = main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
