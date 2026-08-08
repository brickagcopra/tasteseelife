#!/usr/bin/env node
// Taste & See — bundle-size budget checker (TS-009b).
//
// Reads bundle-budget.json, locates each app's Next.js build manifest,
// gzips every JS file referenced by each budgeted route, and fails if the
// total exceeds the configured ceiling.
//
// Usage:
//   node scripts/check-bundle-budget.mjs            # check every app in the config
//   node scripts/check-bundle-budget.mjs <appKey>   # check a single app (e.g. @taste-and-see/web-marketing)
//
// Exit codes:
//   0 — all routes within budget
//   1 — at least one route exceeded its budget OR a config/build problem
//   2 — invalid CLI invocation
//
// No third-party deps — uses Node's built-in zlib + fs only.

import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error('Usage: check-bundle-budget.mjs [<app-key>]');
  process.exit(2);
}
const appFilter = args[0];

const configPath = join(REPO_ROOT, 'bundle-budget.json');
if (!existsSync(configPath)) {
  console.error(`bundle-budget.json not found at ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.apps || typeof config.apps !== 'object') {
  console.error('bundle-budget.json missing required "apps" object');
  process.exit(1);
}

const targets = Object.entries(config.apps).filter(
  ([appKey]) => !appFilter || appKey === appFilter,
);

if (targets.length === 0) {
  console.error(
    appFilter
      ? `No app key "${appFilter}" in bundle-budget.json. Known: ${Object.keys(config.apps).join(', ')}`
      : 'No apps configured in bundle-budget.json',
  );
  process.exit(1);
}

const results = [];

for (const [appKey, appCfg] of targets) {
  if (appCfg.framework !== 'next-app-router') {
    console.error(
      `[${appKey}] framework "${appCfg.framework}" not supported by check-bundle-budget.mjs (only "next-app-router" today).`,
    );
    process.exit(1);
  }

  const appDir = resolve(REPO_ROOT, appCfg.path);
  const nextDir = join(appDir, '.next');
  if (!existsSync(nextDir)) {
    console.error(
      `[${appKey}] .next/ not found at ${nextDir}. Run \`pnpm -F ${appKey} build\` first.`,
    );
    process.exit(1);
  }

  // Next.js App Router writes app-build-manifest.json with one entry per
  // route under "pages": { "/page": [...js paths...], "/_not-found/page": [...] }.
  const appManifestPath = join(nextDir, 'app-build-manifest.json');
  if (!existsSync(appManifestPath)) {
    console.error(`[${appKey}] app-build-manifest.json missing — is this an App Router build?`);
    process.exit(1);
  }
  const appManifest = JSON.parse(await readFile(appManifestPath, 'utf8'));

  for (const [routeKey, routeCfg] of Object.entries(appCfg.routes)) {
    // Convention: "/page" in the manifest corresponds to the "/" route;
    // a nested route like "/about" becomes "/about/page".
    const manifestKey = routeKey === '/' ? '/page' : `${routeKey}/page`;
    const chunks = appManifest.pages?.[manifestKey];
    if (!chunks || chunks.length === 0) {
      console.error(
        `[${appKey}] route "${routeKey}" not found in app-build-manifest.json (looked for "${manifestKey}"). Available: ${Object.keys(appManifest.pages ?? {}).join(', ')}`,
      );
      process.exit(1);
    }

    let totalGzipped = 0;
    const perChunk = [];
    for (const rel of chunks) {
      if (!rel.endsWith('.js')) continue; // CSS doesn't count toward the JS budget
      const absPath = join(nextDir, rel);
      if (!existsSync(absPath)) {
        console.error(`[${appKey}] manifest referenced missing chunk ${absPath}`);
        process.exit(1);
      }
      const buf = await readFile(absPath);
      // gzip level 9 mirrors what most CDNs serve at the edge for static assets;
      // it gives a tighter and more reproducible measurement than the default.
      const gzipped = gzipSync(buf, { level: 9 }).byteLength;
      totalGzipped += gzipped;
      const { size: raw } = await stat(absPath);
      perChunk.push({ chunk: rel, raw, gzipped });
    }

    const budget = routeCfg.maxGzippedJsBytes;
    const overBy = totalGzipped - budget;
    results.push({
      appKey,
      route: routeKey,
      totalGzipped,
      budget,
      overBy,
      perChunk,
    });
  }
}

// Reporting -----------------------------------------------------------------

const fmt = (bytes) => `${(bytes / 1024).toFixed(1).padStart(7)} KB`;

let anyFail = false;
for (const r of results) {
  const status = r.overBy > 0 ? 'FAIL' : 'PASS';
  if (status === 'FAIL') anyFail = true;
  const headline = `${status}  ${r.appKey}  route ${r.route}  gzipped ${fmt(r.totalGzipped)} / budget ${fmt(r.budget)}`;
  // eslint-disable-next-line no-console
  console.log(headline);
  for (const c of r.perChunk) {
    // eslint-disable-next-line no-console
    console.log(`        ${fmt(c.gzipped)} (raw ${fmt(c.raw)})  ${c.chunk}`);
  }
  if (status === 'FAIL') {
    // eslint-disable-next-line no-console
    console.log(`        OVER by ${fmt(r.overBy)}`);
  }
}

// GitHub Actions: emit the same table to the step summary so reviewers don't
// have to scroll the raw log.
if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryLines = [
    '### Bundle-size budget',
    '',
    '| App | Route | Gzipped | Budget | Status |',
    '| --- | --- | ---: | ---: | --- |',
    ...results.map(
      (r) =>
        `| \`${r.appKey}\` | \`${r.route}\` | ${(r.totalGzipped / 1024).toFixed(1)} KB | ${(r.budget / 1024).toFixed(1)} KB | ${r.overBy > 0 ? `**OVER by ${(r.overBy / 1024).toFixed(1)} KB**` : 'within budget'} |`,
    ),
    '',
  ].join('\n');
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryLines + '\n');
}

process.exit(anyFail ? 1 : 0);
