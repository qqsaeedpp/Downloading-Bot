# Deployment

Production runs as five Compose services: `postgres`, `redis`, a one-shot
`migrate`, and the two application processes `bot` and `worker`. The bot receives
updates and queues work; the worker runs yt-dlp, FFmpeg and the upload. They are
separate images on purpose — the bot image has no writable media volume, so "the
bot must never download" is a property of the deployment rather than a rule someone
has to remember.

## Prerequisites

- Docker Engine 24+ with the Compose v2 plugin (`docker compose`, not `docker-compose`).
- A bot token from [@BotFather](https://t.me/BotFather).
- Outbound HTTPS to `api.telegram.org`, to the five platforms' CDNs, and to
  `github.com` at build time (the images download the pinned `yt-dlp_linux`).
- Disk for the `downloads` volume. It is scratch space — every job creates and
  deletes its own directory — but it must hold the largest concurrent set of
  in-flight downloads. Budget at least `MAX_DOWNLOAD_MB × DOWNLOAD_WORKER_CONCURRENCY × replicas`,
  plus `MIN_FREE_DISK_MB` headroom.
- Node 22+ and npm only if you intend to build or run migrations outside Docker.

## 1. Configuration

```bash
cp .env.example .env
```

Compose reads `.env` from the project directory automatically. Two variables have
no default and fail the `docker compose` command itself if unset:

| Variable             | Why                                                     |
| -------------------- | ------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | `${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}` |
| `POSTGRES_PASSWORD`  | `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}`   |

Everything else in `docker-compose.yml` has a `:-default`.

Two things about `.env.example` that surprise people:

- **`DATABASE_URL` and `REDIS_URL` in `.env` are ignored by Compose.** The
  `x-app-env` anchor composes its own from the Postgres credentials and points
  both at the service names:
  ```yaml
  DATABASE_URL: postgresql://${POSTGRES_USER:-tgtools}:${POSTGRES_PASSWORD:?…}@postgres:5432/${POSTGRES_DB:-telegram_tools}
  REDIS_URL: redis://redis:6379
  ```
  Those `.env` values matter only when you run the processes on the host
  (`npm run dev:bot`) against `docker-compose.dev.yml`.
- **`YTDLP_PATH`, `FFMPEG_PATH` and `FFPROBE_PATH` come from the image**, not from
  `x-app-env`. `Dockerfile.worker` sets all three. `Dockerfile.bot` sets
  **`YTDLP_PATH` only** — that image has no FFmpeg and nothing in the bot resolves
  the other two, so pointing them at binaries that were never installed is exactly
  the mistake it used to make.
- **`DATABASE_POOL_MAX`, `QUEUE_REMOVE_COMPLETE_AFTER_SECONDS` and
  `QUEUE_REMOVE_FAIL_AFTER_SECONDS` are not in the `x-app-env` anchor**, so under
  Compose they always take their schema defaults (10, 3600, 604800). Add them to
  the anchor if you need to change them.

### Coherence rules that fail startup

`packages/config/src/load-config.ts` parses the environment with Zod and then runs
`assertCoherent`, which checks relationships a per-field schema cannot see. Every
problem is collected and reported at once, and the process throws
`ConfigurationError` before anything connects. The rules, verbatim in effect:

1. `MAX_UPLOAD_MB > 50` while `TELEGRAM_USE_LOCAL_API` is false → refused. 50 MB is
   the public Bot API's hard limit; booting with `MAX_UPLOAD_MB=2000` against it
   would look healthy and then fail every single upload.
2. `TELEGRAM_USE_LOCAL_API=true` with no `TELEGRAM_API_ROOT` → refused.
3. `MAX_UPLOAD_MB > MAX_DOWNLOAD_MB` → refused; "nothing could ever grow large
   enough to use that headroom".
4. `MAX_TRANSCODE_MB > MAX_DOWNLOAD_MB` → refused.
5. `DOWNLOAD_JOB_LOCK_DURATION_MS >= JOB_TIMEOUT_MS` → refused, "otherwise a job
   can never be reclaimed after a worker dies".
6. `DOWNLOAD_TIMEOUT_MS + FFMPEG_TIMEOUT_MS + TELEGRAM_UPLOAD_TIMEOUT_MS > JOB_TIMEOUT_MS`
   → refused. The job would be killed before its slowest legal path completes. The
   shipped defaults sum to 2 700 000 ms against a 3 600 000 ms budget.

The failure surfaces as `fatal: bot failed to start: ConfigurationError: Invalid
configuration: …` on stderr with exit code 1.

### Cookies (optional)

`docker-compose.yml` bind-mounts `./secrets` read-only at `/run/secrets` for both
`bot` and `worker`. If you supply cookie files, the `*_COOKIES_PATH` variables must
be **container** paths:

```
INSTAGRAM_COOKIES_PATH=/run/secrets/instagram.txt
```

Files must be Netscape `cookies.txt` format — `looksLikeNetscapeCookieJar` checks
for the `# Netscape HTTP Cookie File` header or a tab-separated seven-field row, and
logs a warning and continues anonymously otherwise. A missing, unreadable or empty
file degrades to anonymous access rather than failing the job. Create the directory
before the first `up`, since Compose would otherwise create it as root-owned:

```bash
mkdir -p secrets
```

## 2. Bring it up

```bash
docker compose build          # no service list — see the warning below
docker compose up -d
docker compose ps
```

Expected steady state: `postgres` and `redis` healthy, `migrate` exited 0, `bot`
and `worker` running and healthy.

> **Build every service, not a subset.** `docker compose build bot worker`
> looks complete and is not: `migrate` is a separate service, so it keeps
> whatever image it was last built with. A stale migrate image contains an older
> `infra/migrations/`, finds nothing pending, and **exits 0** — so the deploy
> looks clean while the schema silently stays a version behind. `migrate` and
> `worker` now share one image tag to make this much harder, but the habit of
> passing no service list is the reliable protection.
>
> `migrate` verifies the platform enum after running and exits non-zero if the
> schema is still behind, so this failure now announces itself.

## 3. Migrations

`migrate` is a one-shot service. `docker-compose.yml` explains why:

```yaml
# One-shot. Migrations must not run from the services themselves: two
# replicas booting at once would race on the same DDL, and a failed migration
# should stop a deploy rather than crash-loop a bot.
migrate:
  build:
    context: .
    dockerfile: Dockerfile.worker
  restart: 'no'
  command: ['node', 'apps/worker/dist/migrate.js']
  depends_on:
    postgres:
      condition: service_healthy
```

Both application services then declare:

```yaml
migrate:
  condition: service_completed_successfully
```

so a failed migration blocks the deploy instead of leaving a bot running against a
schema it does not understand.

The entry point is `apps/worker/src/migrate.ts`: it loads the config, builds a
logger and calls `runMigrations` from `@tgtools/database`, which uses a dedicated
single connection (`max: 1`) because Drizzle takes an advisory lock for the run.
Applying twice is a no-op; CI asserts that.

It lives **inside the worker app** rather than in `infra/scripts/`, and that is
load-bearing rather than tidiness. A loose `.ts` file outside every package is
compiled by nothing and copied by nothing: `Dockerfile.worker`'s build stage takes
`packages/`, `features/` and `apps/`, so a script anywhere else is one the image
silently does not contain, and the `migrate` service fails with `Cannot find
module` on the first deploy. Because it sits under `apps/worker/src`, the ordinary
`turbo run build` compiles it to `apps/worker/dist/migrate.js` alongside
`bootstrap.js`, and the runtime stage copies it with everything else.

The runtime stage also copies `infra/migrations`, which is where the SQL itself
lives: `packages/database/src/migrate.ts` resolves `MIGRATIONS_FOLDER` relative to
its own location — three levels up, then `infra/migrations` — which is correct both
from source and from `dist`.

To run migrations from the host instead (against `docker-compose.dev.yml`, or a
database you reach directly):

```bash
npm run db:migrate
```

which is `node --env-file-if-exists=.env --import tsx apps/worker/src/migrate.ts`
— the same entry point, run from source through `tsx`, reading `DATABASE_URL` from
`.env` if one is present.

## 4. Health endpoints

Both processes serve two endpoints on `0.0.0.0`, from
`packages/shared/src/health/health-server.ts`:

| Path            | Bot  | Worker | Behaviour                                                                            |
| --------------- | ---- | ------ | ------------------------------------------------------------------------------------ |
| `/health/live`  | 3001 | 3002   | Always 200 with `{status, service, version, uptimeSeconds}`. The process is running. |
| `/health/ready` | 3001 | 3002   | 200 when every check passes, 503 otherwise, with a `checks` array.                   |

Anything else returns 404. Readiness runs all checks in parallel under a single
5 s budget; a check that throws is reported as `healthy: false` rather than
propagating.

**Bot readiness** (`apps/bot/src/bootstrap.ts`) — three checks:

```ts
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      // yt-dlp, and ONLY yt-dlp. The bot inspects; it never decodes, muxes or
      // re-encodes, so asserting FFmpeg here would fail a container that is
      // working perfectly.
      healthCheck('yt-dlp', () => assertExecutable(config.binaries.ytDlp)),
    ],
```

`ping()` is `select 1` for Postgres and a `PING`/`PONG` round trip for Redis. The
bot's `assertExecutable` returns early for a bare command name — a path with no
separator is resolved by the OS at spawn time, so there is nothing to stat.

**Worker readiness** (`apps/worker/src/bootstrap.ts`) — six checks:

```ts
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      healthCheck('yt-dlp', () => assertExecutable(config.binaries.ytDlp)),
      healthCheck('ffmpeg', () => assertExecutable(config.binaries.ffmpeg)),
      healthCheck('ffprobe', () => assertExecutable(config.binaries.ffprobe)),
      healthCheck('download-dir', () => container.engine.workspaces.ensureWritable()),
    ],
```

`assertExecutable` is `access(path, constants.X_OK)`; `ensureWritable` creates the
root, makes a temporary directory in it and removes it.

The asymmetry is deliberate and is the quickest way to confirm a correct
deployment by hand:

```bash
docker compose exec worker which ffmpeg   # must succeed
docker compose exec bot    which yt-dlp   # must succeed
docker compose exec bot    which ffmpeg   # EXPECTED TO FAIL — this is correct
```

The bot image has never installed FFmpeg, and it no longer sets `FFMPEG_PATH` or
`FFPROBE_PATH` either. Inspection is `yt-dlp --dump-single-json`, which decodes
nothing; `YtDlpNodeRunner.dumpJson` runs the binary through `execFile` directly
rather than through `ytdlp-nodejs` precisely so that no FFmpeg dependency is
dragged into a process that has no use for one. A non-empty
`docker compose exec bot which ffmpeg` means someone has added a dependency that
belongs in the worker.

Separately, the worker refuses to start at all if `probeToolchain()` cannot get a
version out of yt-dlp — _"Fail loudly at startup rather than on the first user's
download."_

Both Dockerfiles wire `HEALTHCHECK` to `/health/ready`:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||3002)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

`docker-compose.yml` publishes the two health ports and nothing else, bound to
loopback: `127.0.0.1:${BOT_HEALTH_PORT:-3001}:3001` and the worker's equivalent on 3002. Postgres and Redis have no host mapping at all and stay on the internal
bridge network. So readiness is reachable from the host:

```bash
curl -fsS http://127.0.0.1:3001/health/ready | jq
curl -fsS http://127.0.0.1:3002/health/ready | jq
```

or from inside a container (both images have `curl`):

```bash
docker compose exec bot    curl -s localhost:3001/health/ready
docker compose exec worker curl -s localhost:3002/health/ready
```

Change the bind address only if an external load balancer or monitoring agent
genuinely needs it; the endpoints are for the host's monitoring, not the internet.

## 5. Graceful shutdown

`installGracefulShutdown` (`packages/shared/src/lifecycle/graceful-shutdown.ts`)
handles `SIGTERM` and `SIGINT`, runs the steps in order exactly once, and has a hard
deadline after which it calls `process.exit(1)` regardless. `tini` is PID 1 in both
images so the signal actually reaches Node — and so a killed yt-dlp child does not
become a zombie.

**Bot** (`buildBotShutdownSteps`): stop polling → close health server → close the
download queue → close Redis → close Postgres. Deadline 20 s, `stop_grace_period: 30s`.

**Worker** (`buildWorkerShutdownSteps`): pause the BullMQ worker without stopping
in-flight jobs (`worker.pause(false)`) → stop the maintenance loop → unsubscribe
from cancellations → **drain running jobs** → close the worker → health server →
queue → Redis subscriber → Redis → Postgres.

The drain step is the one that matters:

```ts
        const deadline = Date.now() + graceMs;
        while (container.running.size > 0 && Date.now() < deadline) { … await delay(1_000); }
        if (container.running.size > 0) {
          const aborted = container.running.abortAll(new OperationCancelledError('Worker is shutting down'));
          …
          await delay(2_000);
        }
```

`graceMs` is `WORKER_SHUTDOWN_GRACE_MS` (default 30 000). The worker's shutdown
deadline is set to `config.queue.shutdownGraceMs + 30_000` — 60 s by default.

**`stop_grace_period` must exceed `WORKER_SHUTDOWN_GRACE_MS`.** Compose says so in
a comment:

```yaml
# Must exceed WORKER_SHUTDOWN_GRACE_MS, or Docker SIGKILLs the worker while
# it is still giving an in-flight download its chance to finish.
stop_grace_period: 90s
```

Docker sends `SIGTERM`, waits `stop_grace_period`, then `SIGKILL`s. If the grace
period is shorter, the worker is killed mid-drain: the job keeps its BullMQ lock
until `lockDuration` expires, a half-written file is left on the shared volume for
the orphan sweep to find, and the user's progress message stops updating with no
explanation. The 90 s default covers the 30 s drain, the 2 s abort settle, and the
process's own 60 s deadline with room to spare. **If you raise
`WORKER_SHUTDOWN_GRACE_MS`, raise `stop_grace_period` to at least
`WORKER_SHUTDOWN_GRACE_MS + 60s`.**

## 6. Scaling the worker

```bash
docker compose up -d --scale worker=3
```

Three things make that safe:

1. **Per-job workspaces.** `createWorkspaceFactory` uses `mkdtemp`, so uniqueness
   comes from the kernel and two workers starting the same instant cannot collide.
   The comment explains why this is not cosmetic: _"yt-dlp SKIPS an output whose
   file already exists and then reports the stale path, so a shared directory turns
   'give me 1080p' into 'here is the 720p someone else downloaded an hour ago'."_
   All replicas share the `downloads` volume; each job owns one `job-XXXXXX`
   directory inside it and deletes it on every exit path.
2. **BullMQ locks.** `createWorker` sets `lockDuration: DOWNLOAD_JOB_LOCK_DURATION_MS`,
   `stalledInterval: lockDuration / 2` and `maxStalledCount: 1`. Exactly one worker
   holds a job. On top of that, `ProcessDownloadUseCase` re-reads the row, refuses
   redeliveries of completed/cancelled/expired jobs, and claims the job with an
   optimistic-locking conditional write — if it loses, it logs _"could not claim the
   job; another actor moved it first"_ and returns `'skipped'`. And
   `BullMqDownloadQueue.enqueue` passes `{ jobId: payload.jobId }`, so the queue
   itself rejects a duplicate add.
3. **Redis cancellation pub/sub.** A cancel tap lands in the bot process, which
   publishes the job id on `tgtools:download:cancel`. Every worker subscribes; the
   one holding that job aborts its `AbortController` via `RunningJobRegistry`, the
   rest log _"cancellation was for a job on another worker"_ and do nothing. Without
   it, "cancel" would be a row update while yt-dlp kept pulling bytes until the job
   timeout fired minutes later. Delivery is best-effort by design — the `cancelled`
   row is the durable record, so a missed message costs a download that finishes and
   is discarded, not a wrong outcome. The worker uses a **second** Redis connection
   for the subscriber, because a client in subscriber mode refuses every other
   command.

Total concurrency is `DOWNLOAD_WORKER_CONCURRENCY × replicas`. Each slot can hold
`MAX_DOWNLOAD_MB` on disk and an FFmpeg re-encode's worth of CPU, so scale disk and
cores together. Do **not** scale the bot: two processes long-polling the same token
steal each other's updates. (The worker deliberately builds a bare `Api` client and
never a `Bot`.)

## 7. The 50 MB ceiling and a local Bot API server

Telegram's public Bot API refuses any upload over 50 MB, whatever you configure.
`PUBLIC_API_UPLOAD_LIMIT_MB = 50` in `packages/config/src/load-config.ts` and rule 1
of `assertCoherent` enforces it.

`MAX_DOWNLOAD_MB` and `MAX_UPLOAD_MB` are deliberately separate numbers: a file can
download fine and still be undeliverable. When that happens,
`ProcessDownloadUseCase.#assertDeliverable` catches it _before_ spending minutes
streaming to Telegram and fails the job with `MEDIA_TOO_LARGE`.

To lift the ceiling to 2000 MB, run your own
[telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server. Add it to
`docker-compose.yml` on the `internal` network, then set:

```
TELEGRAM_API_ROOT=http://telegram-bot-api:8081
TELEGRAM_USE_LOCAL_API=true
MAX_UPLOAD_MB=2000
MAX_DOWNLOAD_MB=2000     # must be >= MAX_UPLOAD_MB
MAX_TRANSCODE_MB=2000    # must be <= MAX_DOWNLOAD_MB
```

`TELEGRAM_API_ROOT` is threaded into both `createBot` and `createTelegramApi` as
grammY's `apiRoot`; an empty value means the public API. The schema caps
`MAX_UPLOAD_MB` at 2000. Note that `useLocalApi` is currently only used for the
coherence rule and a debug log line — the code path still uploads via multipart
`InputFile`, so the local server needs no shared-volume access to work.

## 8. Updating yt-dlp

The version is pinned as a build arg in **both** Dockerfiles and defaulted again in
`docker-compose.yml`:

```dockerfile
# yt-dlp changes weekly and an unpinned image means a rebuild can silently
# change extractor behaviour on a Friday afternoon.
ARG YTDLP_VERSION=2026.07.04
```

```yaml
args:
  YTDLP_VERSION: ${YTDLP_VERSION:-2026.07.04}
```

Both images download `yt-dlp_linux` from the GitHub release and run `--version` at
build time, so a truncated download fails the build rather than the first user's
link. The bot image carries yt-dlp too — it runs metadata extraction only, because
a quality menu has to reflect the formats a post really offers. It does **not**
carry FFmpeg, and must not start to: see §4.

The procedure:

```bash
# 1. Validate the candidate against the real extractors, without deploying it.
gh workflow run smoke.yml -f ytdlp_version=2026.08.01
#    (or locally:)
RUN_SMOKE_TESTS=1 SMOKE_INSTAGRAM_URL=… SMOKE_TIKTOK_URL=… \
  SMOKE_PINTEREST_URL=… SMOKE_X_URL=… npm run test:smoke

# 2. If green, bump the default in both Dockerfiles, commit, and rebuild.
docker compose build --build-arg YTDLP_VERSION=2026.08.01
docker compose up -d
```

`.github/workflows/smoke.yml` is `workflow_dispatch`-only, takes an optional
`ytdlp_version` input (defaulting to whatever `Dockerfile.worker` pins), and needs
the `SMOKE_*_URL` secrets in the `smoke` environment; without them each case skips
itself. The workflow header explains the choice: the suite _"fails for reasons
unrelated to any change under review — a site redesign, a rate limit, a link that
has since been deleted"_, so running it per-push would train everyone to ignore a
red build.

The worker logs the toolchain it actually loaded at startup, which is what a bug
report needs:

```
starting worker … ytDlp=2026.08.01 ffmpeg=… ffprobe=…
```

## 9. Backup and restore

Nothing on the `downloads` volume is meant to survive a restart. Postgres holds
users, jobs and events; Redis holds the queue and the inspection cache.

```bash
# Backup (add -Fc for a custom-format dump you can restore selectively)
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-tgtools}" -d "${POSTGRES_DB:-telegram_tools}" \
  > "backup-$(date +%F).sql"

# Restore into a freshly initialised database
docker compose stop bot worker
docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-tgtools}" -d "${POSTGRES_DB:-telegram_tools}" \
  < backup-2026-08-01.sql
docker compose start bot worker
```

Use `-T` so Compose does not allocate a TTY and corrupt the stream with CR bytes.

Redis is configured with `--appendonly yes --maxmemory-policy noeviction` and a
`redis-data` volume, because _"the queue is the only record that a user's job was
accepted; losing it on restart loses their request"_. `noeviction` means Redis
returns errors rather than silently dropping queue keys under memory pressure —
watch for that in the worker logs rather than raising the limit blindly.

To back Redis up as well:

```bash
docker compose exec redis redis-cli BGSAVE
docker compose cp redis:/data/dump.rdb ./redis-dump.rdb
```

## 10. Logs

Every service uses the same anchor:

```yaml
x-logging: &logging
  driver: json-file
  options:
    max-size: '10m'
    max-file: '3'
```

30 MB per service, rotated. The applications write structured JSON to stdout via
pino; keep `LOG_PRETTY=false` in production (pretty-printing spawns a worker thread
and is meant for a terminal). Secrets are redacted at two levels — a `redact.paths`
list and a `scrubText` pass over every message — and URLs are logged through
`redactUrl`, which keeps origin + path and replaces the query with `?<n params>`.

```bash
docker compose logs -f --tail 200 worker
docker compose logs --since 1h bot | jq 'select(.level=="error")'
```

`requestId` ties a bot log line to the worker log line for the same job, minutes
later; it is carried in the queue payload rather than regenerated. Job-scoped lines
also carry `jobId` and `platform`.

To ship logs elsewhere, replace the `x-logging` anchor with your driver of choice
(`gelf`, `awslogs`, `journald`) or point a collector at the container stdout.

## 11. Troubleshooting

| Symptom                                                                                                                                        | Cause                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` fails immediately with `TELEGRAM_BOT_TOKEN is required`                                                                    | `.env` missing or the variable is empty. Compose's `:?` interpolation, not the app.                                                                                                                                       |
| `fatal: bot failed to start: ConfigurationError: Invalid configuration:`                                                                       | One of the `assertCoherent` rules in §1. The message lists every violated rule.                                                                                                                                           |
| `fatal: worker failed to start: yt-dlp is not usable at "/usr/local/bin/yt-dlp"`                                                               | `probeToolchain()` got no version. Bad `YTDLP_PATH`, or the release download in the image build produced a broken binary.                                                                                                 |
| `migrate` exits non-zero with `Cannot find module '/app/apps/worker/dist/migrate.js'`                                                          | The image was built before the migration entry point moved into the worker app, or the build stage did not run. `docker compose build --no-cache migrate`.                                                                |
| `bot`/`worker` never start, stuck on `migrate`                                                                                                 | `service_completed_successfully` is unsatisfied. `docker compose logs migrate`.                                                                                                                                           |
| Worker healthy, jobs queue but never run                                                                                                       | Bot and worker on different Redis instances, or the worker is paused mid-shutdown. Check `download worker started` in the worker log.                                                                                     |
| `job stalled` warnings, files downloaded twice                                                                                                 | `DOWNLOAD_JOB_LOCK_DURATION_MS` too low for a single download step. BullMQ renews at half the duration but only while the processor yields.                                                                               |
| Jobs die at ~60 s under load with no error                                                                                                     | `DOWNLOAD_JOB_LOCK_DURATION_MS` at its 60 000 ms floor against long FFmpeg runs. Raise it (it must stay below `JOB_TIMEOUT_MS`).                                                                                          |
| Every download fails `MEDIA_TOO_LARGE` at the end                                                                                              | `MAX_UPLOAD_MB` is below what the chosen quality produces. Either lower the offered quality ceiling via `MAX_DOWNLOAD_MB` or run a local Bot API server (§7).                                                             |
| `INSUFFICIENT_STORAGE` before anything downloads                                                                                               | The `downloads` volume has less than `MIN_FREE_DISK_MB` free. `assertSpaceAvailable` declines up front rather than filling the disk.                                                                                      |
| Disk creeps up over days                                                                                                                       | Orphan sweep not running, or `ORPHAN_WORKSPACE_MAX_AGE_HOURS` too high. The maintenance loop runs every `MAINTENANCE_INTERVAL_MS` and once at startup; look for `removed orphaned workspace`.                             |
| Log line: _"authenticated attempt failed in a way that suggests an expired session; retrying anonymously — refresh this platform cookie file"_ | Exactly what it says. The retry rescued the link; the cookie file is stale.                                                                                                                                               |
| Log line: _"cookie file is not in Netscape format and will be ignored"_                                                                        | Usually a JSON export from a browser extension. Re-export as `cookies.txt`.                                                                                                                                               |
| Every platform suddenly returns `MEDIA_NOT_FOUND` or `LOGIN_REQUIRED`                                                                          | Extractor drift after a site change. Run the smoke workflow, then bump `YTDLP_VERSION` (§8).                                                                                                                              |
| YouTube alone returns `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot")                                                                 | A datacentre IP range YouTube distrusts. `YOUTUBE_COOKIES_PATH` is the only thing that answers it — the anonymous retry other platforms use is switched off for YouTube because it cannot help.                           |
| `docker compose exec bot which ffmpeg` finds nothing                                                                                           | Correct, and deliberate. The bot inspects only. If it ever needs FFmpeg, the work has landed in the wrong process (§4).                                                                                                   |
| Worker container SIGKILLed during deploys, files left on the volume                                                                            | `stop_grace_period` is not larger than `WORKER_SHUTDOWN_GRACE_MS` (§5).                                                                                                                                                   |
| Progress messages stop updating but the job completes                                                                                          | Normal throttling, or Telegram 429s. `PROGRESS_UPDATE_INTERVAL_MS` / `PROGRESS_UPDATE_MIN_PERCENT` control the rate; `message is not modified` is classified as `not_modified` and deliberately not treated as a failure. |
| Users see _"چند دانلود فعال دارید"_ constantly                                                                                                 | `MAX_ACTIVE_JOBS_PER_USER` (default 2), or jobs stuck in an active status because a worker died without releasing them.                                                                                                   |
| Redis `OOM command not allowed when used memory > 'maxmemory'`                                                                                 | `noeviction` doing its job. Increase Redis memory or lower `QUEUE_REMOVE_FAIL_AFTER_SECONDS`.                                                                                                                             |
| `docker compose exec bot curl …` connection refused                                                                                            | Health server not up yet, or you used the wrong port — the bot is 3001 and the worker is 3002.                                                                                                                            |
