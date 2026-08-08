# worker-media-processor

The **media-processor** worker (TS-201; subsumes the scaffold half of
TS-110-followup-1). A separate long-running process that walks an uploaded
media object through the mandatory CLAUDE.md §3.4 pipeline and reports each
stage outcome to `media-svc`'s internal scan-event ingest, which advances the
`media_assets` row's status.

## Pipeline

```
headObject            → upload_completed
magic-byte sniff      → magic_byte_passed | magic_byte_failed (+ delete → rejected)
ClamAV scan           → scan_passed | scan_failed (infected → delete; unavailable → fail-closed) → rejected
process by class:
  image    (Sharp)    → process_passed (deliveryKey + dims) | process_failed → failed
  video    (ffmpeg)   → process_passed (deliveryKey = HLS manifest, dims = poster) | process_failed → failed
  document (passthru) → process_passed (deliveryKey)
```

An asset becomes consumable (`ready`) only after **both** `scan_passed` and
`process_passed`. A scanner that is unavailable **fails closed** to `rejected`.

## Stub-by-default (ADR-0002)

Every side-effecting stage is an injectable port. Phase-1 ships **stubs** so the
worker boots + the orchestration logic is fully unit-tested **without** Docker,
ffmpeg, ClamAV, or S3. The live adapters swap in behind the same ports:

| Port                  | Live adapter                         | Follow-up                                     |
| --------------------- | ------------------------------------ | --------------------------------------------- |
| `ObjectStorePort`     | `@aws-sdk/client-s3`                 | TS-110-followup-2                             |
| `VirusScannerPort`    | `clamav.js`                          | TS-110-followup-3                             |
| `ImageProcessorPort`  | `sharp`                              | TS-110-followup-4                             |
| `VideoTranscoderPort` | `fluent-ffmpeg` (OS `ffmpeg` binary) | TS-201-followup-1                             |
| `JobSourcePort`       | S3 event → BullMQ                    | TS-201-followup-2                             |
| `ScanEventClientPort` | `fetch` → media-svc ingest           | live now (logging fallback when unconfigured) |

## Video transcode-bomb caps

The video stage rejects a source exceeding `MEDIA_VIDEO_MAX_DURATION_SECONDS`
(default 180s) or `MEDIA_VIDEO_MAX_INPUT_PIXELS` (default ~8.3M = 4K) **before**
any transcode begins — the video analog of Sharp's `limitInputPixels`
(CLAUDE.md §3.4 step 5 / §17.15). The cap logic is the pure, tested
`planVideoTranscode`.

## Configuration

See `src/config/env.ts`. Key knobs: `MEDIA_PROCESSOR_ENABLED` (kill-switch),
`SCAN_EVENT_INGEST_URL` / `SCAN_EVENT_INGEST_API_KEY` (media-svc ingest),
`MEDIA_VIDEO_MAX_DURATION_SECONDS` / `MEDIA_VIDEO_MAX_INPUT_PIXELS`,
`IMAGE_MAX_INPUT_PIXELS`.

## Deferred

- Live adapters (S3 / ClamAV / Sharp / ffmpeg) — the follow-ups above.
- Docker image (`apk add ffmpeg`) + K8s Deployment + build workflow — TS-201-followup-4.
- Dedicated `posterKey` / `durationSeconds` persistence on `media_assets` — TS-201-followup-3.
- Extract the magic-byte detector + per-kind MIME allow-list into a shared
  `@taste-and-see/media-core` package (dedupe vs `service-media`) — TS-201-followup-5.
- Testcontainers / Playwright E2E once the live job source + ffmpeg land.
