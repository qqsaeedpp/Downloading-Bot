# telegram-tools-bot

A production-shaped Telegram bot that downloads media from **Instagram**,
**TikTok**, **Pinterest**, **X / Twitter** and **YouTube**.

Send it a link. It shows you what the post is, offers the qualities the source
actually has, and delivers the file — normalised so it plays inline rather than
freezing on the first frame.

This is phase one of a multi-tool bot, so the architecture is built for the
second and tenth tool as much as for this one.

---

## What it does

- **Five platforms**, each with its own download policy rather than a scattered
  `switch`. Short links (`vm.tiktok.com`, `pin.it`, `t.co`) are resolved safely.
  A platform may also declare a canonical URL shape: YouTube collapses
  `youtu.be`, `/shorts`, `/embed`, `/live`, `music.` and timestamp links onto one
  `watch?v=<id>`, so the same video shared six ways is one cache entry.
- **Real quality menus** — heights the source genuinely offers, with an audio
  ladder capped by what the source can support. It will not offer you 320 kbps
  for a 64 kbps track.
- **Video, audio and images**, including image-only Pinterest pins and Instagram
  photo posts.
- **Playback normalisation.** An MP4 container is not the same thing as a
  playable file; VP9, AV1 and HEVC are re-encoded to H.264/AAC with the moov
  atom at the front.
- **Live progress** in Persian, throttled so a fast download does not get the
  chat rate-limited.
- **Cancellation** that actually stops the running process, across the
  process boundary.
- **Two-tier size limits**, per-job workspaces, graceful shutdown, health
  endpoints and structured logs with per-request correlation.

---

## Architecture at a glance

```
Telegram ──▶ apps/bot ──BullMQ──▶ apps/worker ──▶ Telegram
                 │                     │
                 └──── PostgreSQL ─────┘
                        Redis
```

The bot receives updates and queues work. The worker runs yt-dlp, FFmpeg and the
upload. They are separate processes because a single 400 MB download inside the
bot would block every other user's update for as long as it ran.

```
apps/          bot and worker processes (composition roots)
features/      vertical slices: downloader, start, help, users
packages/      shared plumbing: config, logger, database, queue, telegram, engine
infra/         SQL migrations
docs/          the documents listed at the bottom of this file
tests/         integration, e2e, and the opt-in smoke suite
```

Inside a feature: `domain/` (framework-free) → `application/` (use cases, ports
only) → `infrastructure/` + `presentation/` (adapters). These directions are
enforced by ESLint, not just documented — see
[`eslint.config.js`](./eslint.config.js).

Full detail, including the architecture decisions and why each alternative was
rejected, is in [docs/architecture.md](./docs/architecture.md).

---

## Requirements

|                  | Version          | Notes                                   |
| ---------------- | ---------------- | --------------------------------------- |
| Node.js          | 22+              | 24 also works for local development     |
| Docker + Compose | recent           | the only supported production path      |
| PostgreSQL       | 17               | provided by Compose                     |
| Redis            | 7                | provided by Compose                     |
| yt-dlp           | pinned per image | see [updating yt-dlp](#updating-yt-dlp) |
| FFmpeg + ffprobe | any current      | worker image only; the bot has neither  |

---

## Quick start (production)

```bash
git clone <this repo> && cd telegram-tools-bot
cp .env.example .env
```

Edit `.env`. Only three variables have no default:

```env
TELEGRAM_BOT_TOKEN=   # from @BotFather
POSTGRES_PASSWORD=    # anything long and random
DATABASE_URL=         # ignored by Compose, required by the schema
```

> Compose builds its own `DATABASE_URL` and `REDIS_URL` from the service names,
> so the values in `.env` are only used when you run outside Compose.

```bash
mkdir -p secrets            # cookie mount point; may stay empty
docker compose up -d --build
docker compose logs -f bot worker
```

The `migrate` service runs once and both services wait for it to succeed.

Verify:

```bash
curl -fsS http://127.0.0.1:3001/health/ready | jq
curl -fsS http://127.0.0.1:3002/health/ready | jq
```

The worker's readiness probe checks Postgres, Redis, the three binaries
(yt-dlp, ffmpeg, ffprobe) and that the download directory is writable. The
bot's checks Postgres, Redis and **yt-dlp only** — it inspects but never
decodes, so asserting FFmpeg there would fail a container that is working
perfectly.

---

## Development

```bash
npm install
docker compose -f docker-compose.dev.yml up -d    # Postgres + Redis only
cp .env.example .env                              # point at localhost
npm run db:migrate

npm run dev:bot       # terminal 1
npm run dev:worker    # terminal 2
```

The worker needs `yt-dlp`, `ffmpeg` and `ffprobe` on `PATH`, or set
`YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH`. The bot needs only `yt-dlp`:
metadata extraction runs it directly through `execFile` and touches no media.

| Command                    | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `npm run build`            | compile every package (Turborepo)                            |
| `npm run check-types`      | typecheck everything, including `tests/`                     |
| `npm run lint`             | ESLint, including the layer-boundary rules                   |
| `npm run format`           | Prettier                                                     |
| `npm test`                 | unit tests                                                   |
| `npm run test:integration` | real filesystem, scripted yt-dlp                             |
| `npm run test:e2e`         | whole flows against in-memory adapters                       |
| `npm run test:smoke`       | **hits the real internet** — opt in with `RUN_SMOKE_TESTS=1` |
| `npm run db:generate`      | generate a migration from the Drizzle schema                 |
| `npm run db:migrate`       | apply pending migrations                                     |

---

## Configuration

Every variable is documented in [`.env.example`](./.env.example) and validated by
Zod at startup. An invalid value fails the process immediately rather than
surfacing as a mystery later.

Some checks are about _relationships between_ variables, and each exists because
the failure it prevents is otherwise invisible until a real job runs:

- `MAX_UPLOAD_MB` above **50** requires a local Bot API server
  (`TELEGRAM_USE_LOCAL_API=true` + `TELEGRAM_API_ROOT`). Telegram's public API
  refuses anything larger, so without this the bot would look healthy and fail
  every upload.
- `MAX_UPLOAD_MB` ≤ `MAX_DOWNLOAD_MB`, and `MAX_TRANSCODE_MB` ≤ `MAX_DOWNLOAD_MB`.
- `JOB_TIMEOUT_MS` ≥ download + ffmpeg + upload timeouts, or a job is killed
  before its slowest legal path can finish.
- `DOWNLOAD_JOB_LOCK_DURATION_MS` < `JOB_TIMEOUT_MS`, or a job can never be
  reclaimed after a worker dies.

### Size limits

Three different numbers, for three different reasons:

| Variable           | Bounds                                   | Default |
| ------------------ | ---------------------------------------- | ------- |
| `MAX_DOWNLOAD_MB`  | what may be pulled from the network      | 500     |
| `MAX_UPLOAD_MB`    | what Telegram will accept                | 50      |
| `MAX_TRANSCODE_MB` | above this, remux instead of re-encoding | 250     |

A file can clear the download ceiling and still be undeliverable, which is why
the upload ceiling is checked before the upload starts rather than discovered
as a 413 afterwards.

`MAX_DOWNLOAD_MB` is enforced **twice**: `--max-filesize` catches the sources
that declare a size, and a runtime watchdog polling the workspace every three
seconds catches the ones that do not — which is most of them.

---

## Cookies (optional)

The bot works fully unauthenticated, and that is the configuration to prefer.

If you need access to content only a logged-in account can see, export a
Netscape `cookies.txt` and mount it read-only:

```bash
mkdir -p secrets
cp ~/Downloads/instagram-cookies.txt secrets/
```

```env
INSTAGRAM_COOKIES_PATH=/run/secrets/instagram-cookies.txt
```

Cookies never enter the queue, the database or a job payload. They are read at
the moment of use, written to a `0600` temp file for one call, and deleted.

**Read [docs/security.md](./docs/security.md) before enabling this.** Use only
an account you control and are permitted to automate; a leaked cookie file is a
full account takeover.

If a session goes stale the log says so:

```
authenticated attempt failed in a way that suggests an expired session; retrying anonymously
```

A stale session is _worse_ than none — Instagram answers an invalidated
`sessionid` with a flat 404 on a reel that resolves fine anonymously — so the
bot retries once without cookies and tells you to refresh the file.

That retry is per-platform (`retryWithoutCookies`), and YouTube switches it off:
its "Sign in to confirm you're not a bot" check is answered _by_ cookies, so
dropping them and trying again is the one thing guaranteed not to help.

---

## Updating yt-dlp

Extractors break when sites change. The version is pinned in both Dockerfiles
so a rebuild cannot silently change behaviour:

```dockerfile
ARG YTDLP_VERSION=2026.07.04
```

To update:

```bash
# 1. Check what the new version does with real links
gh workflow run smoke.yml -f ytdlp_version=2026.08.01

# 2. If it passes, bump both Dockerfiles and rebuild
docker compose build --build-arg YTDLP_VERSION=2026.08.01
docker compose up -d
```

Never enable unattended updates in production: a yt-dlp release can change
format selection behaviour, and you want that to be a decision.

The running version is in the worker's startup log:

```json
{ "msg": "starting worker", "ytDlp": "2026.07.04", "ffmpeg": "ffmpeg version 6.1.1" }
```

---

## Operations

```bash
# Health
curl -fsS http://127.0.0.1:3002/health/ready

# Scale the worker
docker compose up -d --scale worker=3

# Backup
docker compose exec -T postgres pg_dump -U tgtools telegram_tools | gzip > backup.sql.gz

# Restore
gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U tgtools telegram_tools
```

Scaling the worker is safe: each job gets its own workspace directory, BullMQ
holds a per-job lock, and cancellation reaches whichever replica holds the job
via Redis pub/sub.

**Graceful shutdown.** On SIGTERM the worker stops accepting jobs, gives
in-flight ones `WORKER_SHUTDOWN_GRACE_MS` to finish, then aborts the rest so
they release their locks and delete their workspaces. `stop_grace_period` in
Compose must exceed that value, or Docker SIGKILLs the worker mid-cleanup.

More in [docs/deployment.md](./docs/deployment.md).

---

## Extending

- **Add a feature** → [docs/adding-a-feature.md](./docs/adding-a-feature.md).
  Build a `BotFeature`, add it to `apps/bot/src/register-features.ts`.
- **Add a platform** → [docs/adding-a-platform.md](./docs/adding-a-platform.md).
  Write a `PlatformDefinition`, register it, add the slug to the vocabulary and
  the database enum. A test fails if those two drift apart.

---

## Documentation

|                                                     |                                                     |
| --------------------------------------------------- | --------------------------------------------------- |
| [architecture.md](./docs/architecture.md)           | layers, package map, and the architecture decisions |
| [downloader-flow.md](./docs/downloader-flow.md)     | what happens at each step, and why                  |
| [error-model.md](./docs/error-model.md)             | how a failure becomes a sentence                    |
| [security.md](./docs/security.md)                   | SSRF, injection, secrets, privacy                   |
| [deployment.md](./docs/deployment.md)               | production operation and troubleshooting            |
| [testing.md](./docs/testing.md)                     | the four suites and what each is for                |
| [adding-a-feature.md](./docs/adding-a-feature.md)   | extending the bot                                   |
| [adding-a-platform.md](./docs/adding-a-platform.md) | extending the downloader                            |

---

## Known limitations

Stated plainly, because the alternative is someone discovering them in
production:

- **Extractors are fragile by nature.** A site redesign can break a platform
  overnight. That is a property of the problem, not of this code; the smoke
  workflow exists to tell you quickly.
- **Carousels take the first item.** A multi-image Instagram post, or a tweet
  with four photos, downloads its first entry. Choosing between items needs UI
  that phase one does not have.
- **YouTube playlists are not downloaded.** A link carrying `list=` is collapsed
  to the single video it explicitly names before it reaches yt-dlp, so pasting a
  playlist link gets you that one video and not two hundred.
- **The bot image has no FFmpeg, deliberately.** Inspection runs
  `yt-dlp --dump-single-json`, which decodes nothing, so the dependency would buy
  nothing and invite the bot to start doing work that belongs in the worker.
  `docker compose exec bot which ffmpeg` failing is the design, not a fault.
- **50 MB without a local Bot API server.** Larger files require running your
  own, which is a deployment decision this repo documents but does not automate.
- **No retention policy.** Job rows persist until deleted. Add one before
  handling other people's links at scale.
- **`QueueName.MediaInspect` is declared but unwired.** Inspection runs inline in
  the bot, which is fast enough; the queue name exists so moving it later is a
  wiring change rather than a redesign.
- **The end-to-end tests use in-memory adapters.** They exercise the real use
  cases, state machine and locking, but not Postgres or Redis. The integration
  suite covers the real filesystem; a full stack test needs live datastores.

---

## Legal

This bot processes only what yt-dlp can ordinarily retrieve with the access it
is given. It does not circumvent platform protections.

**Responsibility for use rests with the operator.** Respect copyright, respect
the terms of service of every platform you point it at, and only supply
credentials for accounts you own and are permitted to automate. Extractors may
need updating as sites change.

---

## Licence

MIT.
