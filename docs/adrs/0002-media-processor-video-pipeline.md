# ADR-0002 — `media-processor` worker + provider-video transcoding (`fluent-ffmpeg`)

- **Status:** Accepted
- **Date:** 2026-05-29
- **Deciders:** Product / Engineering (owner: brickagcopra)
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** TS-201 (provider video-intro upload + transcoding); subsumes the scaffold half of TS-110-followup-1 (media-processor worker)

---

## Context

`media-svc` (TS-110) ships the signed-URL issuance + asset-metadata + internal
scan-event ingest surface, but the **media-processor** that walks an uploaded
object through the mandatory CLAUDE.md §3.4 pipeline (magic-byte → ClamAV →
Sharp/transcode) does not exist yet — it was carved as TS-110-followup-1. The
whole pipeline is therefore stub-only: assets advance `awaiting_upload → … →
ready` only when a test POSTs to `POST /api/v1/internal/media/scan-events`.

TS-201 layers a **video** path on top: a provider records a short intro video
(`provider_video_intro` kind — already in the media contract + per-kind size
cap of 200 MiB + `video/mp4`,`video/webm` allow-list), and the platform must
produce a delivery-ready artifact (an HLS manifest + a poster thumbnail) only
**after** the ClamAV scan passes, then populate `providers.video_intro_key`.
TS-201 cannot be delivered without first standing up the media-processor worker
it is meant to extend (CLAUDE.md §16 — "create the smallest viable scaffold …
and proceed").

Image resize is Sharp (already approved, CLAUDE.md §13). Video transcoding needs
a tool the approved list does not yet carry. PDD §15.1 + §21.5 + PRD §7.1/§7.2
all call for the provider video introduction; the approved-libraries list (§13)
is image-only today.

## Decision

### 1. Video transcoding library: `fluent-ffmpeg` against an OS-provided `ffmpeg` binary

Add **`fluent-ffmpeg`** (+ `@types/fluent-ffmpeg` as a dev dep) to the
approved-libraries list (CLAUDE.md §13, backend). `fluent-ffmpeg` is a thin,
well-established Node wrapper that shells out to the system `ffmpeg`/`ffprobe`
binaries — it does **not** bundle a binary itself.

We deliberately **reject the static-binary npm packages** (`ffmpeg-static`,
`@ffmpeg-installer/ffmpeg`): their prebuilt binaries are **glibc**-linked, and
the platform's runtime image is `alpine:3.22` (PDD §20.1), which is **musl**.
A glibc static binary fails to exec on musl. The correct supply is the distro
package: the media-processor's container adds `apk add --no-cache ffmpeg` in its
runner stage, and `fluent-ffmpeg` finds `ffmpeg`/`ffprobe` on `PATH`. This keeps
the binary patched by the base-image update cadence (a security win over a
pinned-in-`node_modules` binary) and avoids shipping a ~70 MiB binary inside
`node_modules`.

Approving `fluent-ffmpeg` now (ahead of the live adapter) means the upcoming
live-wiring follow-up has no library-ADR blocker.

### 2. Stand up `apps/workers/media-processor` as a stub-by-default worker

A new worker app under `apps/workers/media-processor/` (mirroring the
`identity-janitor` / `outbox-relay` worker idiom — NestJS shell, `setTimeout`
scheduler, `/healthz`+`/readyz`, `@taste-and-see/nest-observability`,
fail-fast env). Its core is a **pure, fully-unit-tested orchestrator**
(`MediaProcessorService`) that sequences the pipeline and emits the existing
scan-events to `media-svc`'s internal ingest. Every side-effecting stage is an
**injectable port**:

| Port                                            | Phase-1 impl             | Live wiring (deferred)                    |
| ----------------------------------------------- | ------------------------ | ----------------------------------------- |
| `ObjectStorePort` (head/read/sha256/delete)     | in-memory stub           | `@aws-sdk/client-s3` — TS-110-followup-2  |
| `VirusScannerPort` (clean/infected/unavailable) | configurable stub        | `clamav.js` — TS-110-followup-3           |
| `ImageProcessorPort` (resize → WebP variant)    | deterministic stub       | `sharp` — TS-110-followup-4               |
| `VideoTranscoderPort` (probe → HLS + poster)    | deterministic stub       | `fluent-ffmpeg` — **TS-201-followup-1**   |
| `ScanEventClientPort` (POST scan-events)        | live `fetch` HTTP client | — (already live)                          |
| `JobSourcePort` (yield jobs to process)         | in-memory stub           | S3 event → BullMQ — **TS-201-followup-2** |

This is the same stub-by-default + deferred-live-SDK shape every prior media
task used (TS-110-followup-2/3/4) and every other Phase-1 subsystem (TS-111
search, TS-053/207/210 ranking). It lets the security-critical orchestration
logic — fail-closed scanner handling, magic-byte gating, image-vs-video
branching, transcode-bomb caps, event emission/idempotency — be exhaustively
unit-tested **without** Docker, ffmpeg, ClamAV, or S3 (none of which run on the
Windows author host; see the platform's integration-test posture).

### 3. Video as a first-class processing class with transcode-bomb caps

The orchestrator maps each `MediaAssetKind` to a processing class
(`image` / `video` / `document`). For `video`:

- After `scan_passed`, the `VideoTranscoderPort` probes the source and produces
  an **HLS manifest** (emitted as the asset's `deliveryKey` on `process_passed`)
  plus a **poster thumbnail** (its dimensions ride the existing `width`/`height`
  fields; the poster object key is derived from the manifest key by convention —
  dedicated `posterKey` / `durationSeconds` columns are a deferred follow-up,
  TS-201-followup-3, to avoid a service-media schema + contract ripple in this
  PR). No media contract / `media_assets` schema change is required: the
  existing `process_passed` event shape already carries `deliveryKey` + `width`
  - `height`.
- **Transcode-bomb protection** is the video analog of Sharp's
  `limitInputPixels` (CLAUDE.md §3.4 step 5 / §17.15): the transcoder enforces a
  configurable **max duration** (`MEDIA_VIDEO_MAX_DURATION_SECONDS`, default 180s
  — a provider intro, not a feature film) and **max source resolution**
  (`MEDIA_VIDEO_MAX_*_PIXELS`). A source exceeding either is **rejected** (→
  `process_failed`, asset `failed`) before any expensive transcode begins, and
  the bytes never become consumable.

### 4. Scan-pass gate before consumable; fail-closed scanner

The asset only reaches `ready` (delivery URL mintable) after `scan_passed` AND
`process_passed`. A scanner that is **unavailable** (timeout / socket closed)
yields `scan_failed` (reason `clamav_unavailable`) → the asset transitions to
`rejected`, never `ready` — defending the read surface against a degraded
scanner (CLAUDE.md §3.4 step 6). This is encoded in the orchestrator and tested.

## Consequences

**Positive**

- TS-201's pipeline logic is unblocked, fully unit-tested, and shippable with no
  Docker/ffmpeg/ClamAV/S3 on the author host.
- The media-processor scaffold (the TS-110-followup-1 shell) lands here, so the
  remaining live-SDK follow-ups (-2/-3/-4 + the new video follow-ups) become
  drop-in adapter swaps behind stable ports.
- `fluent-ffmpeg` + the musl-aware binary-supply decision are recorded before
  any live code depends on them.

**Negative / deferred**

- `fluent-ffmpeg` is approved but **not yet added to `package.json`** — the live
  `FfmpegVideoTranscoder` adapter that imports it is **TS-201-followup-1** (no
  unused dependency lands now).
- The worker has no live job source yet — `JobSourcePort` is an in-memory stub;
  the S3-event → BullMQ wiring is **TS-201-followup-2** (depends on the
  platform's BullMQ infra, same gate as every other deferred worker).
- The Docker image's `apk add ffmpeg` + the media-processor K8s Deployment +
  build workflow are **TS-201-followup-4** (twin of TS-009g-followup-4 /
  TS-022-followup-3c).
- Dedicated `posterKey` / `durationSeconds` persistence (a service-media schema
  - contract additive migration) is **TS-201-followup-3**.

## Alternatives considered

- **`ffmpeg-static` / `@ffmpeg-installer/ffmpeg`** — rejected (glibc binary,
  incompatible with the alpine/musl runtime image; also bloats `node_modules`).
- **A cloud transcoding service (AWS MediaConvert / Mux / Cloudflare Stream)** —
  defer to Phase 3. Adds a vendor + cost + a webhook surface for a Phase-1
  feature (short provider intros) that a single `ffmpeg` invocation handles. The
  port boundary leaves this swap open later without touching the orchestrator.
- **Transcode inline in `media-svc`** — rejected. Transcoding is long-running
  CPU-bound work that must not run in an HTTP handler (CLAUDE.md §17.14); it
  belongs in a worker (PDD §7.2 service-inventory + the media-processor split).
