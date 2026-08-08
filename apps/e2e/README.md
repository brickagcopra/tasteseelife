# @taste-and-see/e2e

End-to-end suite for the Taste & See platform (TS-505, CLAUDE.md §9.1).

## What it does

Starts a real fleet of services from their compiled `dist/`, against a real
Postgres and Redis, and drives the **api-gateway over HTTP**. Nothing is mocked
and nothing is stubbed.

```
pnpm --filter @taste-and-see/e2e test:e2e
```

Prerequisites: `pnpm infra:up` (Postgres + Redis), and a build — `turbo run
test:e2e` handles the build via `dependsOn: ["^build"]`.

## Why it is shaped this way

**It drives the gateway, not the services.** Services on this platform do not
call one another; the gateway is the aggregator and it is what signs the
`x-ts-actor-*` trust headers every downstream verifies. A suite that called
`service-identity` directly would skip the edge that authenticates,
rate-limits, re-validates every response shape, and signs the actor envelope —
which is most of what can break between two green unit suites.

**API-level, not browser-level.** No browser is launched, so no
`playwright install` and no browser binaries in CI. The money path CLAUDE.md
§9.1 names is a sequence of backend state transitions across eight bounded
contexts; asserting it through the gateway asserts the thing that can break.
Browser specs over the four Next.js portals are a separate, additive slice.

**Serial, with no retries.** The money path is one narrative over shared
platform state. Where the platform is genuinely eventually-consistent
(outbox → consumer), the spec waits explicitly with a stated budget, so the
wait is part of the assertion instead of hidden in a retry count.

**The fleet's environment is the repository's `.env.example`.** TS-504
established that file as the complete, boot-capable documented environment
(verified by executing every app's real `loadEnv()` against it). Reusing it here
means the suite exercises the configuration a fresh clone gets — and if someone
adds a required env var without updating the file, the fleet stops booting.
Only three classes of value are overridden per service: the database URL, the
port, and a few local-transport settings the shipped defaults set for
production (`REFRESH_COOKIE_SECURE`).

## Layout

| Path                     | Role                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/fleet.ts`           | Which services participate, on which ports, owning which schema. The one place to edit when a slice grows.        |
| `src/global-setup.ts`    | Provision database → migrate → start fleet. Returns its own teardown.                                             |
| `src/database.ts`        | Drops and rebuilds `tastesee_e2e`, then `prisma migrate deploy` per schema owner.                                 |
| `src/fleet-processes.ts` | Spawns each service as a direct `node` child, waits for `/healthz` then `/readyz`, logs to `test-results/fleet/`. |
| `src/gateway-client.ts`  | HTTP transport with **no cookie jar** — every cookie on the wire is one a spec put there.                         |
| `src/auth-flows.ts`      | `registerVerifiedUser()` and friends: the four calls it takes to have a usable account.                           |
| `src/outbox-reader.ts`   | Reads domain events, standing in for the consumer that will drain them.                                           |
| `tests/*.spec.ts`        | The specs.                                                                                                        |

## Knobs

| Variable                   | Default | Effect                                                                                                                                      |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_RESET_DATABASE`       | `true`  | `false` keeps the database and only applies pending migrations. An iteration convenience — a run that way proves less, so CI never sets it. |
| `E2E_LOG_LEVEL`            | `warn`  | Service log level. `debug` when a failure needs a service's own view.                                                                       |
| `E2E_READINESS_TIMEOUT_MS` | `60000` | Per-service start-up budget.                                                                                                                |

## Notes for whoever extends it

- **The harness owns the processes; Playwright's `webServer` is deliberately
  unused.** `webServer` entries start as a _plugin_, and plugin setup runs
  before `globalSetup` — which is exactly backwards when migrations must
  complete before any service opens a pool.
- **A stray dev fleet makes the suite fail loudly, not silently.** Ports are the
  services' own declared defaults and `reuseExistingServer` is off, so an
  already-running service produces `EADDRINUSE` rather than a suite that quietly
  tests against the development database.
- **Adding a service to `FLEET` is a claim that a spec reaches it.** A service
  listed but never exercised is fleet start-up cost with no coverage.
- **What this suite has already found**, on its first two runs, before a single
  spec of the money path existed: `api-gateway` could not boot at all
  (`RateLimitGuard`'s metrics dependency was unexported), no account created
  through signup could ever log in (no activation path existed — TS-510), and
  the shared RFC 7807 filter was dropping the machine-readable `code` four
  features branch on. None of the three was visible to any unit suite.
