# Architecture

A modular monolith: one codebase, one deployment unit, two processes. Features
are vertical slices with their own domain, application, infrastructure and
presentation layers; the shared plumbing lives in packages beneath them.

The organising constraint is that this is **phase one of a multi-tool bot**. The
downloader is the first feature, not the product. Every boundary below exists so
that the second and tenth tool can land without disturbing the first.

---

## Process topology

```
                    ┌──────────────┐
   Telegram ───────▶│  apps/bot    │  receives updates, answers questions,
                    │              │  queues work. Never downloads.
                    └──────┬───────┘
                           │ BullMQ (Redis)
                           ▼
                    ┌──────────────┐
                    │ apps/worker  │  yt-dlp, FFmpeg, disk, upload.
                    │              │  Never polls for updates.
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        PostgreSQL                  Telegram API
```

Two processes, not one, because a single 400 MB download inside the bot would
block every other user's `/start` for as long as it ran. Node is
single-threaded; a slow `await` is a stalled event loop for everyone.

The split is enforced by the images, not by discipline: **the bot image has no
writable media volume.** It could not download even if a bug tried to.

---

## Request flow

```
Telegram update
  → requestContext middleware        assigns a requestId + scoped logger
  → rateLimit middleware             fixed-window counter in Redis
  → userContext middleware           upsert, attach ctx.user
  → downloader composer
      ├─ message with a link → InspectMediaUseCase
      │     → UrlGuard.parse           SSRF checks, normalisation
      │     → RedirectResolver         short links only
      │     → cache lookup             hashed normalised URL
      │     → MediaDownloaderPort      → engine → yt-dlp --dump-single-json
      │     → renders a quality card
      └─ callback query → RequestDownloadUseCase
            → ownership + expiry + version checks
            → job row → queued
            → BullMQ enqueue (jobId as the queue's job id)

worker picks up the message
  → ProcessDownloadUseCase
      → re-read row, decide whether the work is still wanted   ← idempotency
      → claim it with a version-checked write
      → MediaDownloaderPort.download
            workspace → yt-dlp → size watchdog → ffprobe
            → PlaybackNormalizer → thumbnail
      → TelegramMediaSenderPort.send
      → status: completed
      → workspace cleanup                                       ← always
```

---

## Layers, and what may import what

```
        domain           entities, value objects, errors, ports
           ▲             framework-free by construction
      application        use cases, policies, orchestration
           ▲             talks to ports only
  infrastructure / presentation
                         adapters: Drizzle, BullMQ, grammY, the engine
```

These rules are **enforced by ESLint**, not merely documented — a boundary
nobody checks erodes on the first "just this once". `eslint.config.js` gives
`features/*/src/domain/**` and `features/*/src/application/**` a
`no-restricted-imports` rule listing every framework package, and gives
`packages/downloader-engine/**` its own rule barring grammY, BullMQ, Drizzle and
the database.

---

## Package map

| Package                       | Owns                                                                                                                                                                                             | Deliberately does not know about |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `@tgtools/shared`             | `Result`, `AppError`, `Clock`, `IdGenerator`, filename/path safety, byte and duration formatting, cancellation scopes, the health server, graceful shutdown, and the **shared media vocabulary** | anything with a dependency       |
| `@tgtools/config`             | Zod env schema → `AppConfig`, plus the cross-variable coherence checks                                                                                                                           | how anything is used             |
| `@tgtools/logger`             | Pino behind the `Logger` port, redaction, free-text scrubbing                                                                                                                                    | any domain concept               |
| `@tgtools/database`           | Drizzle schema, client, migrator                                                                                                                                                                 | any feature's meaning            |
| `@tgtools/queue`              | BullMQ connection, queue names, worker factory                                                                                                                                                   | any payload's shape              |
| `@tgtools/telegram`           | Bot/API factories, `AppContext`, error classification, safe edits, the `BotFeature` contract                                                                                                     | any feature                      |
| `@tgtools/downloader-engine`  | Platforms, SSRF guard, yt-dlp, FFmpeg, workspaces, cookies                                                                                                                                       | Telegram, users, jobs, Persian   |
| `features/downloader`         | The product behaviour                                                                                                                                                                            | how yt-dlp works                 |
| `features/{start,help,users}` | Their own slice                                                                                                                                                                                  | each other                       |

---

## Architecture decisions

Short ADRs. Each records the alternative that was rejected, because that is the
part a future reader cannot reconstruct.

### ADR-1 — TypeScript with the strict flags on

`strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`noImplicitOverride`. The last three are the ones that hurt, and the ones that
pay: extractor output is full of fields that may be absent, and
`noUncheckedIndexedAccess` is what forces `formats[0]` to be treated as possibly
undefined — which it genuinely is on Pinterest.

_Rejected:_ plain `strict`. It permits `array[0].height` and that expression is
a crash waiting for a photo post.

### ADR-2 — grammY over Telegraf and node-telegram-bot-api

grammY has first-class TypeScript types for the full Bot API, a composer model
that maps exactly onto the feature-per-composer structure, and `@grammyjs/auto-retry`
for 429 handling. Its context flavouring gives typed `ctx.user` without a
runtime wrapper.

_Rejected:_ Telegraf — weaker types on newer API surfaces and a middleware model
that makes per-feature isolation harder.

### ADR-3 — NestJS was not used

The requirement was explicit, and it matches the design: dependency injection
here is a composition root plus constructor parameters
(`apps/bot/src/container.ts`). A container that resolves by decorator makes the
dependency graph implicit, and the graph is the thing we most want to be able to
read.

_Cost:_ the wiring is written by hand. _Benefit:_ it is 150 readable lines, and
every use case is constructible in a test with three fakes and no framework.

### ADR-4 — The worker is a separate process

Not a thread, not a queue inside the bot. yt-dlp and FFmpeg are external
processes; the supervising work is I/O-bound, but the _upload_ streams hundreds
of megabytes through the same event loop that answers `/help`.

Separate processes also mean the worker can be scaled independently
(`--scale worker=3`) and restarted without dropping updates.

### ADR-5 — BullMQ over a database-backed queue

Downloads need retry with exponential backoff, per-job locks with renewal,
stalled-job recovery, and a bounded concurrency the operator can tune. Building
that on `SELECT … FOR UPDATE SKIP LOCKED` is a month of work to reach parity.

_Consequence:_ Redis becomes load-bearing, and its `appendonly` setting matters —
losing the queue loses accepted requests.

### ADR-6 — PostgreSQL over SQLite or Mongo

The job row is written by two processes at once and needs a real optimistic-lock
predicate (`WHERE id = ? AND version = ?`). It also needs `jsonb` for the event
payloads and partial indexes for the active-job count. SQLite's single-writer
model breaks the first requirement the moment a second worker exists.

### ADR-7 — Drizzle over Prisma

Migrations are plain reviewable SQL in `infra/migrations/`, the query builder is
typed without a generation step in the runtime image, and there is no engine
binary to ship. CI can therefore assert schema drift by re-running `generate`
and checking for a dirty tree.

### ADR-8 — yt-dlp behind a port

`MediaDownloaderPort` is the only thing the domain knows about downloading. The
engine implements it; the feature's adapter maps between the two vocabularies.

_Why the mapping cost is worth paying:_ the engine's model is shaped by what an
extractor reports, and the domain's by what a card shows. Sharing one model
would mean every yt-dlp field rename reaches the presentation layer. It also
makes the whole download pipeline testable with a scripted fake — which is what
`tests/integration/engine-pipeline.test.ts` does, with no network and no binary.

### ADR-9 — A shared kernel for the media vocabulary

`MediaPlatform`, `DownloadType`, `MediaKind`, `DownloadStage` and
`DownloadProgress` live in `@tgtools/shared`, imported by both the domain and
the engine.

_Rejected:_ duplicating them on each side of the port. Two enums that must stay
in step, with a mapper between, is more code and more drift than one dependency
on a pure-data module with no dependencies of its own. `@tgtools/shared` is
otherwise held to a strict rule — nothing goes in unless at least two layers
genuinely need the same word.

### ADR-10 — One workspace directory per job

yt-dlp **skips** an output whose file already exists and then reports that stale
path. With a shared directory and a `%(title)s` template, a 1080p request can
hand back the 720p file someone else downloaded an hour ago — or, worse, another
user's identically-titled file. `mkdtemp` gets uniqueness from the kernel, and a
private directory means cleanup is one `rm -r`.

### ADR-11 — Codec normalisation is not optional

`--merge-output-format mp4` sets the **container**, never the codec. Telegram's
mobile clients decode H.264 reliably and little else: a VP9 reel shows its first
frame and then freezes while the audio keeps playing.

So: probe with ffprobe, remux when the codecs are already safe (which still
fixes the moov atom position that makes players stall), and re-encode when they
are not — unless the file is over `MAX_TRANSCODE_MB`, where the CPU cost stops
being worth it. See `planNormalization`, which is pure and unit-tested.

### ADR-12 — A two-tier size limit

`--max-filesize` only fires when the extractor declared a size up front.
Instagram, TikTok and every HLS stream declare nothing, so the flag alone is not
a limit — it is a limit on the links that were already honest. The runtime
watchdog polls the workspace every 3 seconds and aborts the process when the
total passes the ceiling.

_Why 3 seconds:_ at 10, a fast link pulled ~160 MB past the ceiling before the
first check ran.

### ADR-13 — Cancellation over Redis pub/sub

The tap lands in the bot; the running yt-dlp lives in a worker. Marking the row
`cancelled` is durable but does not stop the process, so the intent is broadcast
on a channel and the worker holding that job aborts it.

Pub/sub, not a queue: the message is worthless a second later, only one
subscriber cares, and if nobody is listening there is nothing to deliver. The
row remains the durable record, so a missed message costs a download that
finishes and is discarded — not a wrong outcome.

### ADR-14 — Optimistic locking on every state transition

Two actors touch a job. Each conditional write states the version it read and is
rejected if that is no longer current, so a double tap, a redelivered queue
message, or a cancel racing a completion resolves deterministically instead of
by whoever wrote last.

The in-memory test repository implements the same rule, so the end-to-end tests
exercise the real races rather than a fake that cannot reproduce them.
