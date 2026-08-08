#!/usr/bin/env node
/**
 * seal-secrets.mjs — turn one operator-held values file into the committed
 * SealedSecret set for an environment (TS-151-followup-2).
 *
 * ## Why this exists
 *
 * Before this, `infra/kubernetes/README.md` told the operator to hand-type
 * `kubectl create secret generic …` for each workload and then delete that
 * workload's `secret-placeholder.yaml` from the overlay's `resources:` list.
 * At 30 workloads and 133 keys that is not a runbook, it is a dare — and the
 * failure mode of forgetting the deletion is that the next `kubectl apply`
 * silently overwrites a real credential with `REPLACE_WITH_…`, after which
 * every affected pod fails Zod validation at boot.
 *
 * This script reads the placeholders as the authoritative key inventory, so
 * the inventory cannot drift from what the pods actually mount: a key added to
 * a placeholder is a key this script demands a value for.
 *
 * ## Modes
 *
 *   --template            Write a blank values file covering every workload and
 *                         key. Start here.
 *   --check               Validate a values file: nothing missing, nothing
 *                         unknown, no `REPLACE_WITH_` left behind. Needs no
 *                         cluster and no kubeseal — run it in CI or offline.
 *   --seal --env <env>    Encrypt with kubeseal and write the overlay
 *                         component. Needs the cluster's public key.
 *   --stub --env <env>    Same outputs, fake ciphertext. Lets the kustomize
 *                         wiring be render-tested with no cluster in reach.
 *                         NEVER apply stub output.
 *
 * ## The safety property that matters
 *
 * A SealedSecret's ciphertext is bound to (namespace, name). Sealing against
 * the wrong namespace produces a manifest the controller will refuse to
 * decrypt — a failure that surfaces only at sync time, so this script reads
 * each workload's namespace out of its own kustomization.yaml rather than
 * assuming `platform-services`. Nine of the 30 workloads are not in it.
 *
 * ## Usage
 *
 *   node infra/kubernetes/scripts/seal-secrets.mjs --template > secrets.dev.env
 *   $EDITOR secrets.dev.env            # fill in; NEVER commit this file
 *   node infra/kubernetes/scripts/seal-secrets.mjs --check --values secrets.dev.env
 *   kubeseal --fetch-cert --controller-namespace platform-system \
 *     --controller-name sealed-secrets-controller > /tmp/pub-cert.pem
 *   node infra/kubernetes/scripts/seal-secrets.mjs --seal --env dev \
 *     --values secrets.dev.env --cert /tmp/pub-cert.pem
 *
 * The values file is dotenv-shaped, one `workload.KEY=value` per line. It is
 * matched by `.gitignore`; keep it in a password manager, not on disk.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const KUBE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES_DIR = join(KUBE_DIR, 'services');
const CONTROLLER_NS = 'platform-system';
const CONTROLLER_NAME = 'sealed-secrets-controller';

// -- argument parsing --------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const die = (msg) => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

// -- inventory: read the placeholders ---------------------------------------

/**
 * Parse a `secret-placeholder.yaml` without a YAML library (this repo ships
 * none for tooling, and node has no built-in). The shape is fixed and simple:
 * a `stringData:` block of two-space-indented `KEY: value` pairs. Anything
 * that does not match that exact shape is reported rather than skipped —
 * a silently-dropped key is a pod that will not boot.
 */
const parsePlaceholder = (path) => {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const nameLine = lines.find((l) => /^  name: \S+$/.test(l));
  if (!nameLine) throw new Error(`${path}: no Secret name found`);
  const secretName = nameLine.slice('  name: '.length).trim();

  const start = lines.findIndex((l) => l === 'stringData:');
  if (start === -1) throw new Error(`${path}: no stringData block`);

  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith('  ')) break; // dedent ends the block
    const m = line.match(/^ {2}([A-Z0-9_]+): (.*)$/);
    if (!m) throw new Error(`${path}:${i + 1}: unparsed line in stringData: ${line}`);
    keys.push({ key: m[1], hint: m[2].trim() });
  }
  if (keys.length === 0) throw new Error(`${path}: stringData block is empty`);
  return { secretName, keys };
};

/** A workload's namespace comes from its own kustomization, never assumed. */
const readNamespace = (workloadDir) => {
  const path = join(workloadDir, 'kustomization.yaml');
  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^namespace: \S+$/.test(l));
  if (!line) throw new Error(`${path}: no top-level 'namespace:' — cannot seal safely`);
  return line.slice('namespace: '.length).trim();
};

const buildInventory = () => {
  const workloads = [];
  for (const name of readdirSync(SERVICES_DIR).sort()) {
    const dir = join(SERVICES_DIR, name);
    const placeholder = join(dir, 'secret-placeholder.yaml');
    if (!existsSync(placeholder)) continue; // web apps mount ConfigMap only
    const { secretName, keys } = parsePlaceholder(placeholder);
    workloads.push({ name, namespace: readNamespace(dir), secretName, keys });
  }
  if (workloads.length === 0) die('no secret placeholders found — wrong working directory?');
  return workloads;
};

// -- values file -------------------------------------------------------------

const parseValues = (path) => {
  const out = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`${path}:${i + 1}: not a KEY=VALUE line`);
    const id = line.slice(0, eq).trim();
    // Only the FIRST `=` splits — values legitimately contain `=` (base64
    // padding, connection strings with query params).
    const val = line.slice(eq + 1);
    if (out.has(id)) throw new Error(`${path}:${i + 1}: duplicate entry ${id}`);
    out.set(id, val);
  });
  return out;
};

const validate = (workloads, values) => {
  const problems = [];
  const known = new Set();

  for (const w of workloads) {
    for (const { key } of w.keys) {
      const id = `${w.name}.${key}`;
      known.add(id);
      if (!values.has(id)) {
        problems.push(`MISSING  ${id}`);
        continue;
      }
      const v = values.get(id);
      if (v.trim() === '') problems.push(`EMPTY    ${id}`);
      // The placeholder hints are the exact strings an operator copies by
      // accident when they template the file and forget a row.
      else if (v.trim().startsWith('REPLACE_WITH'))
        problems.push(`UNFILLED ${id} (still ${v.trim()})`);
      // Surrounding whitespace is never intended and is brutal to debug: a
      // trailing space on an HMAC secret fails signature checks at runtime
      // with no hint as to why. Values are NOT auto-trimmed — silently
      // changing a credential is its own bug class — so this is an error the
      // operator resolves, not a fixup.
      else if (v !== v.trim()) problems.push(`WHITESPACE ${id} (leading/trailing space)`);
    }
  }
  for (const id of values.keys()) {
    // An unknown key is usually a typo in a workload name, which would
    // otherwise fail silently as "the value I set had no effect".
    if (!known.has(id)) problems.push(`UNKNOWN  ${id} (no such workload.key in any placeholder)`);
  }
  return problems;
};

// -- output generators -------------------------------------------------------

const templateFile = (workloads) => {
  const total = workloads.reduce((n, w) => n + w.keys.length, 0);
  const out = [
    '# Taste & See — operator secret values.',
    '#',
    '# Generated by infra/kubernetes/scripts/seal-secrets.mjs --template',
    `# ${workloads.length} workloads, ${total} keys.`,
    '#',
    '# NEVER COMMIT THIS FILE. It is matched by .gitignore; it holds live',
    '# credentials in plaintext. Fill it in, seal, then destroy the copy on',
    '# disk — the durable copy belongs in a password manager.',
    '#',
    '# One `workload.KEY=value` per line. EVERYTHING after the first `=` is the',
    '# literal value — there are no trailing comments, because `#` and `=` both',
    '# occur inside real credentials (URL query strings, base64 padding). Each',
    "# key's expected shape is on the comment line above it.",
    '',
  ];
  for (const w of workloads) {
    out.push(`# ---- ${w.name}  (namespace: ${w.namespace}, secret: ${w.secretName})`);
    for (const { key, hint } of w.keys) {
      out.push(`# ${hint}`);
      out.push(`${w.name}.${key}=`);
    }
    out.push('');
  }
  return out.join('\n');
};

const stubSealed = (w, values) => {
  const encrypted = w.keys
    .map(({ key }) => `    ${key}: AgBSTUB${Buffer.from(`${w.name}/${key}`).toString('base64')}`)
    .join('\n');
  return `# STUB — NOT ENCRYPTED. Generated with --stub for render-testing only.
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: ${w.secretName}
  namespace: ${w.namespace}
spec:
  encryptedData:
${encrypted}
  template:
    metadata:
      name: ${w.secretName}
      namespace: ${w.namespace}
    type: Opaque
`;
};

const sealWith = (w, values, certPath) => {
  // Build the plaintext Secret on stdin rather than on the command line:
  // argv is world-readable in /proc on Linux, and these are live credentials.
  const stringData = w.keys
    .map(({ key }) => `  ${key}: ${JSON.stringify(values.get(`${w.name}.${key}`))}`)
    .join('\n');
  const plain = `apiVersion: v1
kind: Secret
metadata:
  name: ${w.secretName}
  namespace: ${w.namespace}
type: Opaque
stringData:
${stringData}
`;
  return execFileSync(
    'kubeseal',
    [
      '--format',
      'yaml',
      '--cert',
      certPath,
      '--controller-namespace',
      CONTROLLER_NS,
      '--controller-name',
      CONTROLLER_NAME,
      // Default scope: the ciphertext is bound to BOTH namespace and name.
      // Do not relax to cluster-wide — a cluster-wide SealedSecret can be
      // unsealed into any namespace by anyone who can create the CR.
      '--scope',
      'strict',
    ],
    { input: plain, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
};

const componentFile = (workloads) => {
  const resources = workloads.map((w) => `  - ${w.name}-secrets.yaml`).join('\n');
  const patches = workloads
    .map(
      (w) => `  - target:
      kind: Secret
      name: ${w.secretName}
    patch: |-
      apiVersion: v1
      kind: Secret
      metadata:
        name: ${w.secretName}
        namespace: ${w.namespace}
      $patch: delete`,
    )
    .join('\n');

  return `# GENERATED by infra/kubernetes/scripts/seal-secrets.mjs — do not hand-edit.
#
# Re-run the script to regenerate. Hand edits are lost, and a hand-edited
# ciphertext is a Secret that fails to unseal at sync time rather than at
# review time.
#
# **A Component, not a plain resource directory.** A component's patches apply
# to the resources its PARENT already accumulated, which is exactly what the
# \`$patch: delete\` directives below need to do: retire each per-service base's
# \`secret-placeholder.yaml\` so the placeholder cannot overwrite the real
# credential on the next apply. A nested kustomization's patches would only see
# its own resources and the placeholders would survive.
#
# Consumed by the overlay via:
#   components:
#     - ./sealed-secrets
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

resources:
${resources}

patches:
${patches}
`;
};

/**
 * Add `components: [./sealed-secrets]` to the overlay, if absent.
 *
 * Done HERE rather than committed up front on purpose: the component directory
 * does not exist until an operator generates it, and an overlay that references
 * a missing component fails to render — which would red the `kubernetes-validate`
 * CI gate for everyone on a clean checkout. Generating and referencing in one
 * step means the two cannot drift, and the repo stays renderable before the
 * first seal.
 *
 * Returns true if it added the reference, false if it was already there.
 */
const wireOverlay = (env) => {
  const path = join(KUBE_DIR, 'overlays', env, 'kustomization.yaml');
  const text = readFileSync(path, 'utf8');
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  const eol = crlf > lf ? '\r\n' : '\n'; // this tree is mixed; match the file
  const lines = text.split(/\r?\n/);

  const ref = '  - ./sealed-secrets';
  if (lines.includes(ref)) return false;

  const header = lines.indexOf('components:');
  if (header === -1) {
    // A file ending in a newline splits to a trailing '' element. Drop those
    // before appending and restore exactly one, or the rewritten file loses
    // its terminating newline.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(
      '',
      '# Generated by infra/kubernetes/scripts/seal-secrets.mjs. The component',
      "# carries this environment's SealedSecrets and the `$patch: delete`",
      '# directives that retire the per-service `secret-placeholder.yaml`',
      '# Secrets, so a placeholder can never overwrite a real credential.',
      'components:',
      ref,
      '',
    );
  } else {
    lines.splice(header + 1, 0, ref);
  }
  writeFileSync(path, lines.join(eol), 'utf8');
  return true;
};

// -- main --------------------------------------------------------------------

const workloads = buildInventory();

if (flag('template')) {
  process.stdout.write(templateFile(workloads));
  process.exit(0);
}

if (flag('check') || flag('seal') || flag('stub')) {
  const valuesPath = value('values');
  if (!valuesPath) die('--values <path> is required');
  if (!existsSync(valuesPath)) die(`values file not found: ${valuesPath}`);
  const values = parseValues(valuesPath);
  const problems = validate(workloads, values);

  if (problems.length > 0) {
    process.stderr.write(`${problems.length} problem(s) with ${valuesPath}:\n`);
    // Sorted so MISSING/UNFILLED/UNKNOWN group together rather than
    // interleaving by workload — the operator fixes them by class.
    for (const p of problems.sort()) process.stderr.write(`  ${p}\n`);
    process.exit(1);
  }

  const total = workloads.reduce((n, w) => n + w.keys.length, 0);
  process.stderr.write(`ok: ${workloads.length} workloads, ${total} keys, all present\n`);
  if (flag('check')) process.exit(0);

  const env = value('env');
  if (!env || !['dev', 'staging', 'prod'].includes(env)) {
    die('--env must be one of dev, staging, prod');
  }

  const stub = flag('stub');
  const certPath = value('cert');
  if (!stub && !certPath) die('--cert <path> is required for --seal (kubeseal --fetch-cert)');
  if (!stub && !existsSync(certPath)) die(`cert not found: ${certPath}`);

  const outDir = join(KUBE_DIR, 'overlays', env, 'sealed-secrets');
  // Removed wholesale: a workload dropped from the inventory must not leave a
  // stale SealedSecret behind that the overlay keeps applying.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  for (const w of workloads) {
    const body = stub ? stubSealed(w, values) : sealWith(w, values, certPath);
    writeFileSync(join(outDir, `${w.name}-secrets.yaml`), body, 'utf8');
  }
  writeFileSync(join(outDir, 'kustomization.yaml'), componentFile(workloads), 'utf8');
  const wired = wireOverlay(env);

  process.stderr.write(
    wired
      ? `wired components: ./sealed-secrets into overlays/${env}/kustomization.yaml\n`
      : `overlays/${env}/kustomization.yaml already references ./sealed-secrets\n`,
  );
  process.stderr.write(
    `${stub ? 'STUBBED' : 'sealed'} ${workloads.length} secrets into overlays/${env}/sealed-secrets/\n`,
  );
  if (stub) {
    process.stderr.write('WARNING: stub output is NOT encrypted. Do not apply or commit it.\n');
  }
  process.exit(0);
}

process.stderr.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
process.exit(1);
