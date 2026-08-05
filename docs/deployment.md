# Deployment

Production runs as eight Compose services: `postgres`, `redis`, a one-shot
`migrate`, the three application processes `bot`, `worker` and `tools-worker`,
and two supporting servers — `bgutil-provider` (YouTube PO tokens) and
`telegram-bot-api`, the local Bot API server that lifts the 50 MB upload ceiling
(§7). The bot receives updates and queues work; the worker runs yt-dlp, FFmpeg
and the upload; the tools worker processes files users send (§12), and is the one
service you can simply not start. They are separate images on purpose — the bot
image has no writable media volume, so "the bot must never download" is a
property of the deployment rather than a rule someone has to remember.

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

Compose reads `.env` from the project directory automatically. Four variables have
no default and fail the `docker compose` command itself if unset:

| Variable             | Why                                                     |
| -------------------- | ------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | `${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}` |
| `POSTGRES_PASSWORD`  | `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}`   |
| `TELEGRAM_API_ID`    | demanded by the `telegram-bot-api` service (§7)         |
| `TELEGRAM_API_HASH`  | demanded by the `telegram-bot-api` service (§7)         |

The last two are an **application** identity from
[my.telegram.org](https://my.telegram.org) — not the bot token, and not derivable
from it. Compose interpolates the whole file before it starts anything, so they are
required even if you never bring that service up; if you do not want a local Bot API
server at all, delete the service from `docker-compose.yml`.

Everything else in `docker-compose.yml` has a `:-default`, with two deliberate
exceptions: `TELEGRAM_UPLOAD_LIMIT_MB` and `MAX_UPLOAD_MB` are written with **no
value at all**, so they can reach the container genuinely unset. `${…:-}` would
deliver an empty string, which the schema coerces to `0` and rejects — and any real
default would be wrong half the time, because the right ceiling depends on whether
local mode is on (§7).

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

1. `TELEGRAM_LOCAL_MODE` and `TELEGRAM_USE_LOCAL_API` set to **different** values →
   refused, and likewise `TELEGRAM_UPLOAD_LIMIT_MB` against `MAX_UPLOAD_MB`. Each
   pair is two spellings of one setting, the second kept so that upgrading does not
   mean editing a running deployment's `.env`. A disagreement is not resolved by
   precedence, because that would silently ignore whichever name the operator
   actually edited — and they would find out when an upload failed.
2. The upload ceiling above **50** while local mode is off → refused. 50 MB is the
   public Bot API's hard limit; booting with `TELEGRAM_UPLOAD_LIMIT_MB=1900` against
   it would look healthy and then fail every single upload.
3. Local mode on with no `TELEGRAM_API_ROOT` → refused. The API root is the thing
   that actually redirects the client; the flag on its own moves nothing.
4. The upload ceiling above `MAX_DOWNLOAD_MB` → refused; "nothing could ever grow
   large enough to use that headroom". This is why `docker-compose.yml` defaults
   `MAX_DOWNLOAD_MB` to **2000** rather than the schema's 500: local mode raises the
   upload ceiling to 1900, and a 500 MB download ceiling would then make "enable
   local mode" produce a stack that refuses to boot.
5. `MAX_TRANSCODE_MB > MAX_DOWNLOAD_MB` → refused.
6. `DOWNLOAD_JOB_LOCK_DURATION_MS >= JOB_TIMEOUT_MS` → refused, "otherwise a job
   can never be reclaimed after a worker dies".
7. `DOWNLOAD_TIMEOUT_MS + FFMPEG_TIMEOUT_MS + TELEGRAM_UPLOAD_TIMEOUT_MS > JOB_TIMEOUT_MS`
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
and `worker` running and healthy, `bgutil-provider` healthy, and `telegram-bot-api`
running with no health status at all — it carries no healthcheck, for the reasons
in §7.

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

Every process serves two endpoints on `0.0.0.0`, from
`packages/shared/src/health/health-server.ts`:

| Path            | Bot  | Worker | Tools | Behaviour                                                                            |
| --------------- | ---- | ------ | ----- | ------------------------------------------------------------------------------------ |
| `/health/live`  | 3001 | 3002   | 3003  | Always 200 with `{status, service, version, uptimeSeconds}`. The process is running. |
| `/health/ready` | 3001 | 3002   | 3003  | 200 when every check passes, 503 otherwise, with a `checks` array.                   |

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

**Tools-worker readiness** (`apps/tools-worker/src/bootstrap.ts`) — three checks,
and none of them is a binary:

```ts
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      // The binaries are NOT re-probed here. They are version checks that fork
      // processes, and running them every ten seconds would spend more CPU on
      // checking than on working. Startup is where they belong.
      healthCheck('workspace', () => container.workspaces.ensureRoot()),
    ],
```

FFmpeg, ffprobe, `pdftocairo`, `pdfinfo`, libmp3lame and Sharp's native binding
are all probed **once at startup** instead, and any failure is fatal (§12).

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
`PUBLIC_API_UPLOAD_LIMIT_MB = 50` in `packages/config/src/load-config.ts` and rule 2
of `assertCoherent` enforce it.

The download and upload ceilings are deliberately separate numbers: a file can
download fine and still be undeliverable. When that happens,
`ProcessDownloadUseCase.#assertDeliverable` catches it _before_ spending minutes
streaming to Telegram and fails the job with `MEDIA_TOO_LARGE`.

### The service

`docker-compose.yml` ships a `telegram-bot-api` service — `aiogram/telegram-bot-api`,
the maintained community build of
[tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api), which publishes
source but no image of its own. It runs with `TELEGRAM_LOCAL=1` (the `--local` flag
is the entire point; without it the server is a private relay that still refuses
anything over 50 MB), sits on the `internal` network, and is reachable as
`telegram-bot-api:8081` and nowhere else. The port is deliberately **not** published:
it carries a bot token in the URL path and authenticates nothing itself.

It needs `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (§1) and keeps its TDLib session
in the `telegram-bot-api-data` volume; deleting that volume costs every bot a fresh
authorisation on the next start. There is no healthcheck, and nothing `depends_on`
it — the image has no curl, wget or interpreter to probe with, and the only endpoint
it answers is `/bot<token>/<method>`, so any check would either be a guess that
reports a working server as `(unhealthy)` forever or would print the bot token into
`docker inspect`.

### Enabling it

Running the container changes nothing on its own. The bot and worker keep talking to
`api.telegram.org` until `.env` redirects them:

```
TELEGRAM_API_ROOT=http://telegram-bot-api:8081
TELEGRAM_LOCAL_MODE=true
```

That is the whole change. Two things are already handled for you:

- **The upload ceiling needs no entry.** `TELEGRAM_UPLOAD_LIMIT_MB` has no default in
  the schema, because the right one depends on this flag: it becomes **1900 MB** with
  local mode on and **50 MB** without it. Set it explicitly only to go lower.
- **`MAX_DOWNLOAD_MB` needs no entry either.** Compose already defaults it to 2000,
  precisely so that rule 4 of `assertCoherent` is satisfied the moment local mode
  turns on.

`TELEGRAM_UPLOAD_LIMIT_MB` is the documented name and `MAX_UPLOAD_MB` the older
spelling of the same setting; `TELEGRAM_LOCAL_MODE` and `TELEGRAM_USE_LOCAL_API` are
the same pair for the flag. Setting both members of a pair to different values is
refused at startup (rule 1). Going back to the public API means the reverse: empty
`TELEGRAM_API_ROOT`, both flags false, and both ceilings 50.

### Why 1900 and not 2000

The schema caps both spellings of the upload ceiling at **1900**, not at the 2000 the
server advertises. The server measures its limit on the **encoded multipart body**,
which is larger than the file inside it, so a ceiling set at exactly 2000 gets the
request refused after the whole file has been streamed — the most expensive possible
moment to discover it. The 100 MB of headroom pays for the encoding overhead.

### What the local server does not change

`MAX_TRANSCODE_MB` stays at its default of **80**, and raising the upload ceiling is
no reason to raise it. It is the size above which an incompatible codec ships as a
document instead of being re-encoded, and that number is set by how long a person
will wait rather than by what the host can survive: a 250 MB VP9 clip is minutes of
CPU during which the user sees a progress message and no file. `VIDEO_FAST_DELIVERY`
(default **true**) is the same trade made absolutely — with it on, an incompatible
codec is never auto re-encoded at all; the original goes out as a document
immediately. A bigger ceiling means bigger files can be _delivered_, not that more of
them get re-encoded.

### How the client is pointed at it

Both processes build their Telegram client through one shared factory,
`packages/telegram/src/bot-factory.ts` — `createBot` for the bot, `createTelegramApi`
for the worker, both resolving the URL through `resolveApiRoot`. They share it
because the two processes disagreeing about where Telegram lives produces the worst
symptom in this system: the bot offers qualities the worker then cannot deliver.

A local server is selected by `apiRoot` and **nothing else**; an empty value means
the public API. grammY also has an `environment` option, and it is never set here on
purpose — it accepts only `prod` and `test`, so anything resembling "local" would be
rejected. The two look interchangeable, which is exactly why it is written down.

Uploads still go over multipart `InputFile`, so the local server needs no
shared-volume access to work.

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
| Every download fails `MEDIA_TOO_LARGE` at the end                                                                                              | The upload ceiling — 50 MB unless local mode is on — is below what the chosen quality produces. Either lower the offered quality ceiling via `MAX_DOWNLOAD_MB` or enable the local Bot API server (§7).                   |
| `docker compose up` fails immediately with `TELEGRAM_API_ID is required by the telegram-bot-api service`                                       | The application identity from my.telegram.org is missing from `.env` (§1). It is demanded even when you do not intend to run that service, because Compose interpolates the whole file.                                   |
| `ConfigurationError: … are two spellings of the same setting and disagree`                                                                     | Both names of an aliased pair are set to different values — `TELEGRAM_LOCAL_MODE`/`TELEGRAM_USE_LOCAL_API`, or `TELEGRAM_UPLOAD_LIMIT_MB`/`MAX_UPLOAD_MB`. Make them identical, or remove one (§7).                       |
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
| `docker compose exec bot curl …` connection refused                                                                                            | Health server not up yet, or you used the wrong port — the bot is 3001, the worker 3002 and the tools worker 3003.                                                                                                        |
| `tools-worker` exits **78** immediately and `restart: unless-stopped` loops it                                                                 | `TOOLS_ENABLED` is false while the service is running. Set it true, or stop the service (§12).                                                                                                                            |
| `fatal: tools-worker failed to start: … native dependencies are unusable`                                                                      | The startup toolchain probe failed. The `toolchain component unusable` lines name which one (§12).                                                                                                                        |

## 12. The tools worker (optional)

`tools-worker` is the third application process, built from `Dockerfile.tools`,
and the one service a deployment can simply not start. It drains four queues —
`tool-image`, `tool-video`, `tool-pdf` and `tool-qr` — and does file processing
only: everything it does begins with a file a user already sent. Full detail is
in [media-tools.md](./media-tools.md).

It is a separate process from `worker` for a different reason than `bot` is. The
two contend for different resources: a fifty-page render or a 4K resize wants a
core flat out, where a download wants bandwidth and a socket held open. Sharing
one worker would mean one user's PDF delaying everyone's videos, and the
concurrency that is right for downloads is wrong for both.

The image carries FFmpeg and `poppler-utils` and **no yt-dlp, no Deno, no
python3, no curl** — those exist purely to fetch from the public internet, which
this process never does. Leaving them out makes "the tools process cannot be
talked into fetching an arbitrary URL" a property of the image.

### It refuses to start when switched off

```
tools-worker: TOOLS_ENABLED is false, so this process has nothing to do.
Set TOOLS_ENABLED=true, or stop running this service.
```

**Exit code 78** (`EX_CONFIG`). Refusing is the honest answer to being switched
off: a process that boots and drains no queues looks healthy to an orchestrator
while every user's job sits in Redis forever. Because the service carries
`restart: unless-stopped`, that refusal becomes a crash loop until you either set
the variable or stop the service.

`TOOLS_ENABLED` lives in the `x-app-env` anchor, so it has **one value for all
three processes**, defaulting to `false` exactly as the schema does. Setting it
per-service was tried and abandoned: the bot reads these settings too — it builds
its menu from the family switches and enforces `MAX_ACTIVE_TOOL_JOBS_PER_USER`
before queueing — and the coherence rules run at startup in every process. Two
sets of ceilings mean the same `.env` boots one container and stops the next,
which is a worse failure than a crash loop because it presents as a bug in one
image rather than as a disagreement between two.

There is no `profiles:` convention in the file to gate the service on, and
inventing one here would leave the other optional services (`bgutil-provider`,
`telegram-bot-api`) gated differently. So the way to run without the tools is to
not start the service:

```bash
docker compose up -d postgres redis bot worker
```

It also refuses to start if `TOOLS_ENABLED` is true but all four family switches
are off, because then no queue would be drained at all. Turning off a single
family is fine — that queue simply gets no consumer, and its jobs wait in Redis
rather than failing.

### The toolchain probe

Before any queue is touched, the process probes FFmpeg, ffprobe, `pdftocairo`,
`pdfinfo`, **libmp3lame inside FFmpeg**, Sharp's native binding (via a real 1×1
encode) and the workspace's writability. Any failure is fatal — unlike a missing
cookie file there is no degraded mode here, and half the tools accepting work and
failing every job is worse than not accepting it.

libmp3lame is checked as an encoder rather than as a binary because an FFmpeg
built without it runs fine and then fails every "video to MP3" job with an
unknown-encoder error, which reads as a bug in this code rather than a gap in the
image. Sharp is loaded rather than imported because its binding resolves lazily,
so a musl/glibc mismatch only surfaces on first use.

```bash
docker compose logs tools-worker | grep toolchain
```

### Ports and volumes

The health port is **3003**, published to loopback only, exactly like the other
two: `127.0.0.1:${TOOLS_WORKER_HEALTH_PORT:-3003}:3003`.

```bash
curl -fsS http://127.0.0.1:3003/health/ready | jq
```

Two volumes, and the split matters:

```yaml
volumes:
  - tools-workspace:/data/tools
  - telegram-bot-api-data:/var/lib/telegram-bot-api:ro
```

- **`tools-workspace`, its own scratch space** — not the downloader's `downloads`
  volume. The two sweep for orphans independently, so a shared directory would
  let one delete the other's in-flight files. The config layer refuses
  `TOOL_WORKSPACE_DIR == DOWNLOAD_DIR` outright rather than leaving that to
  chance. `TOOL_WORKSPACE_DIR` is fixed at `/data/tools` in the compose file
  rather than interpolated, for the same reason `DOWNLOAD_DIR` is: it names a
  mount point inside the container, and a value from someone's `.env` would point
  at a path the volume is not mounted on.
- **The Bot API server's storage, read-only.** This is the one process that reads
  what that server wrote. With `TELEGRAM_LOCAL_MODE` on, `getFile` answers with an
  absolute path on the server's own disk instead of a URL, and sharing the volume
  is what makes that path openable from here. The fetcher copies the file into the
  job workspace rather than working on it in place — the Bot API server deletes
  its copy whenever it likes, and a transcode reading straight from that directory
  would race the deletion — so nothing here ever needs to write, and `:ro` makes
  damaging the server's storage impossible.

  The mount point is the default local file root, so a deployment that follows
  this file sets no `TELEGRAM_LOCAL_FILE_ROOTS`. It is harmless without local
  mode: the roots list is empty then, every file arrives over HTTPS, and the mount
  is never read.

There is **no `./secrets` mount**, unlike `bot` and `worker`. Cookie files exist
for yt-dlp, and this process never fetches from anywhere but Telegram.

`depends_on` includes `migrate: service_completed_successfully` — `tool_jobs`
arrives in `0002_add_tool_jobs.sql`, and without it every job fails on its first
insert. `stop_grace_period` is 90 s, which must exceed the shutdown deadline the
process sets itself (`WORKER_SHUTDOWN_GRACE_MS + 30 s`, so 60 s at the defaults);
Docker would otherwise SIGKILL a container that was still letting a render
finish.

### Disk

Budget the `tools-workspace` volume for the largest concurrent set of in-flight
jobs, plus `TOOL_MIN_FREE_DISK_MB` headroom. Rendering a PDF to images is the
case that surprises people: fifty pages at 150 DPI is fifty full-size PNGs on
disk at once, which dwarfs the 20 MB input that produced them.
