# The file tools

Eight operations on files a user has already sent — image, video, PDF and QR —
and why each of them lives where it does.

They are off by default. `TOOLS_ENABLED=false` is the shipped value, and a
deployment that only wants the downloader should leave it that way: the tools
need a third container, a second scratch volume, FFmpeg, Poppler and libvips,
and none of that earns its keep if nobody is going to resize an image.

---

## Why a third process

```
Telegram ──▶ apps/bot ──BullMQ──▶ apps/worker        ──▶ Telegram
                 │       (downloads)
                 ├──BullMQ──▶ apps/tools-worker      ──▶ Telegram
                 │            (file processing)
                 └──── PostgreSQL ─────────────────────┘
                              Redis
```

The downloader worker and the tools worker contend for different resources. A
download wants bandwidth and a socket held open for minutes; a fifty-page render
or a 4K resize wants a core, flat out, for the whole time it runs. Sharing one
worker would mean one user's PDF delaying everyone's videos, and the concurrency
number that is right for downloads is wrong for both.

The tools worker owns a Telegram `Api` client and never a `Bot`, for the same
reason the downloader worker does: two processes long-polling one token steal
each other's updates.

**`features/tools` deliberately does not depend on `@tgtools/file-tools-engine`.**
That package's entry point loads Sharp's native binding, and the bot imports the
feature to serve menus and enqueue work. Linking libvips into the one process
that must stay responsive to every user's keystrokes, so that it can validate a
page range, is not a trade worth making. The split runs along the native
dependency: the feature owns the domain, the persistence and the presentation,
and `apps/tools-worker` owns the part that actually opens files.

The same reasoning shapes `Dockerfile.tools`, which carries **no yt-dlp and no
Deno**. Both exist to fetch from the public internet, and everything this process
does starts from a file a user already sent. Leaving them out is not a size
optimisation — it makes "the tools process cannot be talked into fetching an
arbitrary URL" a property of the image rather than a rule someone has to
remember. It drops python3, curl and unzip with them.

---

## The eight tools

| `ToolKey`            | Queue        | Concurrency              | Inputs |
| -------------------- | ------------ | ------------------------ | ------ |
| `image.compress`     | `tool-image` | `IMAGE_TOOL_CONCURRENCY` | 1      |
| `image.resize`       | `tool-image` | `IMAGE_TOOL_CONCURRENCY` | 1      |
| `image.convert`      | `tool-image` | `IMAGE_TOOL_CONCURRENCY` | 1      |
| `video.extract_mp3`  | `tool-video` | `VIDEO_TOOL_CONCURRENCY` | 1      |
| `video.remove_audio` | `tool-video` | `VIDEO_TOOL_CONCURRENCY` | 1      |
| `pdf.images_to_pdf`  | `tool-pdf`   | `PDF_TOOL_CONCURRENCY`   | 1–50   |
| `pdf.to_images`      | `tool-pdf`   | `PDF_TOOL_CONCURRENCY`   | 1      |
| `qr.generate`        | `tool-qr`    | `QR_TOOL_CONCURRENCY`    | **0**  |

The keys are dotted rather than flat because the prefix is load-bearing: it
selects the queue, the worker concurrency and the resource ceilings, so it has to
be recoverable from the key alone. `toolFamilyOf` derives the family from the key
rather than keeping a second table that could disagree with it.

Two entries are worth stating plainly:

- **`pdf.images_to_pdf` consumes images but is queued and priced as PDF work.**
  It reads JPEGs and PNGs, so filing it under `image` would be the obvious
  reading of its inputs — and the wrong one. Building the document is where the
  time and the memory go, so it belongs on the PDF queue with the PDF
  concurrency, alongside the other operation that holds a core for a minute.
- **`qr.generate` takes no input file at all.** It is built from typed text,
  which is why it is the one tool whose lifecycle skips a phase entirely.

Four families, four queues, four consumers — not one queue for everything. A
30-minute PDF render sharing a queue with QR generation would leave a user
waiting minutes for an operation that takes 40 ms. Concurrency is the other half
of it: video runs one at a time because two FFmpeg processes on a shared host
make both slower than either alone, while QR runs four because it is pure CPU for
a few milliseconds.

A family switched off with `IMAGE_TOOLS_ENABLED=false` and friends gets **no
consumer at all**, rather than a consumer that rejects what it reads. The
difference matters during an incident: with no consumer the jobs wait in Redis
and run when the family is turned back on; with a rejecting one they burn their
attempt budget and fail permanently. The process refuses to start only if all
four are off, because then nothing would be drained at all.

---

## The job lifecycle

```
pending ─▶ queued ─▶ receiving ─▶ processing ─▶ uploading ─▶ completed
                 └──────────────▶ processing            (QR: no input to fetch)
                          ▲            │           │
                          └── retryable failure ───┘
  any live status ─▶ failed | cancelled | expired
```

`receiving` is separate from `processing` because fetching a file from Telegram
is a distinct, slow phase that fails for entirely different reasons than the
conversion does — and a user watching a stuck job deserves to know which half it
is stuck in. QR moves `queued → processing` directly: there is nothing to
receive, so a `receiving` state it passed through instantly would be a lie in the
status message.

Every transition goes through `assertToolTransition` while the repository asserts
the row's `version` at the same time. Neither check subsumes the other: the guard
rejects a nonsensical move, which is a bug, and the version predicate rejects a
stale one, which is a race. Re-applying the status a row already holds is allowed
— a duplicate queue delivery re-reports what it already wrote, and failing a job
for succeeding twice helps nobody.

### A retryable failure returns the job to `queued`

This edge is load-bearing and easy to leave out.

BullMQ schedules the retry **before** the processor decides what the failure
meant. A processor that wrote `failed` on a temporary Telegram error would leave
the job terminal while a second attempt was already on its way — and that attempt
could then make no legal move at all, because nothing follows `failed`. The job
would be retried and never able to report how it went.

So the processor writes `queued` and rethrows, and the two must agree exactly:

- **retryable, attempts remaining** → row goes back to `queued`, error rethrown
  so BullMQ runs the next attempt. The user keeps seeing "in the queue", which is
  true.
- **anything else** → row goes to `failed` with `error_code` and
  `error_message_safe`, error swallowed.

Rethrowing after writing `failed` produces the stranded job above; swallowing
after writing `queued` produces a job that says "queued" forever with nothing
left to run it.

Which codes are retryable is a short list, and the default is **no**:
`DISK_SPACE_LOW`, `TELEGRAM_FILE_UNAVAILABLE`, `TELEGRAM_UPLOAD_FAILED` and
`INTERNAL_ERROR`. Retrying a corrupt PDF, an encrypted one, a video with no audio
track or an oversized input burns the same CPU to reach the same answer, and on a
shared worker that is capacity taken from someone whose job would have succeeded.
An unrecognised error is assumed transient — the opposite default from the
modelled codes, because we know those are permanent and we do not know that about
this one.

### Fetching the input

The fetcher has two paths, and both end with the bytes inside the job workspace.

With a local Bot API server, `getFile` answers with an absolute path on the
server's own filesystem rather than a URL. The file is **copied** into the
workspace, not opened in place: the Bot API server deletes its copy whenever it
likes, and a processor reading straight from that directory would race the
deletion halfway through a transcode. Three guards apply — the path must land
inside `TELEGRAM_LOCAL_FILE_ROOTS`, it is re-checked for a symlink planted inside
an allowed root, and the size ceiling is enforced from `stat` before the copy
begins.

Against the public API the file is streamed over HTTPS, and the byte ceiling is
counted **as it streams** rather than trusted from `Content-Length` — a header is
a claim, and the ceiling exists to bound what actually lands on disk. The URL
carries the bot token in a path segment, so it is built at the last possible
moment and never logged, stored or attached to an error.

---

## Configuration

Every variable below is in [`.env.example`](../.env.example) with the same
defaults. Bounds are the schema's, from `packages/config/src/env.schema.ts`.

### Master switches

| Variable              | Default | Notes                                            |
| --------------------- | ------- | ------------------------------------------------ |
| `TOOLS_ENABLED`       | `false` | The whole feature. Off unless you want it.       |
| `IMAGE_TOOLS_ENABLED` | `true`  | Per-family. Off means that queue is not drained. |
| `VIDEO_TOOLS_ENABLED` | `true`  |                                                  |
| `PDF_TOOLS_ENABLED`   | `true`  |                                                  |
| `QR_TOOLS_ENABLED`    | `true`  |                                                  |

`docker-compose.yml` sets `TOOLS_ENABLED` to `true` for the `tools-worker`
service while the schema default stays `false`. That is not a contradiction: the
schema answers "should a plain deployment pay for the tools", and the compose
value answers "you have started the tools container". The way to run without them
is to not start the service.

### Session and workspace

| Variable                   | Default       | Bounds    |
| -------------------------- | ------------- | --------- |
| `TOOL_SESSION_TTL_SECONDS` | `900`         | 60–86 400 |
| `TOOL_WORKSPACE_DIR`       | `/data/tools` | —         |
| `TOOL_MIN_FREE_DISK_MB`    | `2048`        | ≥ 0       |
| `TOOL_JOB_TIMEOUT_MS`      | `3600000`     | ≥ 10 000  |
| `TOOL_UPLOAD_TIMEOUT_MS`   | `900000`      | ≥ 10 000  |

The session TTL is how long a half-finished conversation survives: long enough to
find and send a file, short enough that an abandoned draft does not hold a user's
one active slot until they notice.

### Per-family ceilings

Split rather than shared because the resources differ by orders of magnitude. A
12000×12000 image and a two-hour video fail for completely different reasons and
at completely different sizes.

| Variable                          | Default    | Bounds      |
| --------------------------------- | ---------- | ----------- |
| `IMAGE_TOOL_MAX_MB`               | `20`       | 1–2000      |
| `IMAGE_TOOL_MAX_PIXELS`           | `60000000` | ≥ 1 000 000 |
| `IMAGE_TOOL_MAX_DIMENSION`        | `12000`    | ≥ 16        |
| `IMAGE_TOOL_CONCURRENCY`          | `3`        | 1–32        |
| `VIDEO_TOOL_MAX_MB`               | `20`       | 1–4000      |
| `VIDEO_TOOL_MAX_DURATION_SECONDS` | `7200`     | ≥ 1         |
| `VIDEO_TOOL_CONCURRENCY`          | `1`        | 1–8         |
| `VIDEO_TOOL_TIMEOUT_MS`           | `1800000`  | ≥ 10 000    |
| `PDF_TOOL_MAX_MB`                 | `20`       | 1–2000      |
| `PDF_TOOL_MAX_PAGES`              | `50`       | 1–5000      |
| `PDF_TOOL_MAX_IMAGES`             | `50`       | 1–500       |
| `PDF_RENDER_DPI`                  | `150`      | 36–600      |
| `PDF_TOOL_CONCURRENCY`            | `1`        | 1–8         |
| `PDF_TOOL_TIMEOUT_MS`             | `900000`   | ≥ 10 000    |
| `QR_MAX_INPUT_BYTES`              | `1500`     | 16–7089     |
| `QR_TOOL_CONCURRENCY`             | `4`        | 1–32        |
| `QR_TOOL_TIMEOUT_MS`              | `30000`    | ≥ 1000      |

**The three `MAX_MB` defaults are 20, not 50.** The public Bot API refuses
`getFile` above 20 MB whatever the upload ceiling says, so a larger default would
promise to accept files the bot could never collect. Raise them once a local Bot
API server is in play; the coherence rule checks them against what this
deployment can actually fetch.

`IMAGE_TOOL_MAX_PIXELS` guards against a decompression bomb — a few-kilobyte PNG
can declare a canvas large enough to exhaust the host's memory when decoded.
`QR_MAX_INPUT_BYTES` is capped at 7089, which is the QR format's own byte ceiling
and not a number this project chose.

There is deliberately **no** rule relating `IMAGE_TOOL_MAX_DIMENSION` to
`IMAGE_TOOL_MAX_PIXELS`. They guard different things — one an absurd single side,
the other total decoded area — and requiring a square at the dimension ceiling to
fit under the pixel ceiling would forbid ordinary configurations: a 12000×2000
panorama is 24 megapixels and entirely reasonable, while 12000 squared is 144.

### Queue, maintenance and limits

| Variable                              | Default  | Bounds   |
| ------------------------------------- | -------- | -------- |
| `TOOL_QUEUE_JOB_ATTEMPTS`             | `2`      | 1–10     |
| `TOOL_QUEUE_BACKOFF_MS`               | `5000`   | ≥ 100    |
| `TOOL_QUEUE_LOCK_DURATION_MS`         | `60000`  | ≥ 10 000 |
| `TOOL_ORPHAN_WORKSPACE_MAX_AGE_HOURS` | `6`      | 1–168    |
| `TOOL_MAINTENANCE_INTERVAL_MS`        | `900000` | ≥ 60 000 |
| `MAX_ACTIVE_TOOL_JOBS_PER_USER`       | `2`      | 1–20     |
| `TOOL_PROGRESS_UPDATE_INTERVAL_MS`    | `3000`   | ≥ 500    |
| `TOOLS_WORKER_HEALTH_PORT`            | `3003`   | 1–65 535 |

The tools carry their own lock duration rather than inheriting the downloader's:
a fifty-page render holds its lock far longer than a download does, and the
downloader's value would have BullMQ declare a healthy job stalled and hand it to
a second worker — which then renders it again.

### `TELEGRAM_LOCAL_FILE_ROOTS`

Unset by default; a comma-separated list of **absolute** paths. Where a local Bot
API server keeps the files it downloads.

Only the tools worker reads it, and only in local mode — the downloader uploads
files and never fetches one, which is why this variable appears only now. In
local mode `getFile` answers with an absolute path on the server's filesystem,
and this list is what stops a misconfigured or compromised server from aiming
that path at `/etc`. Unset in local mode it defaults to
`/var/lib/telegram-bot-api`, which is where `docker-compose.yml` mounts the
volume, so a deployment that follows the compose file sets nothing.

It is a list rather than a single path because the Bot API server and this worker
can mount the same volume at different places. Relative entries are dropped
rather than resolved against the working directory: "inside `data/`" means
nothing when the path being checked belongs to a different container's
filesystem, and a containment check against a root that is itself relative is not
a check at all. With local mode off the list is empty, deliberately — without a
local server every `file_path` becomes a URL, so a root list would be a
permission granted for no reason.

---

## Coherence rules

`assertCoherent` in `packages/config/src/load-config.ts` checks relationships a
per-field schema cannot see. Every problem is collected and reported at once, and
the process throws `ConfigurationError` before anything connects.

**These five are checked only when `TOOLS_ENABLED=true`** — a downloader-only
deployment should not be refused startup over a ceiling it will never reach.

1. **An input ceiling above what this deployment can fetch.** The fetch ceiling
   is the upload ceiling in local mode and 20 MB otherwise.

   > `IMAGE_TOOL_MAX_MB=50 is above the 20 MB this deployment can download from Telegram, so the bot could never collect a file that large. Lower it, or run a local Bot API server.`

   The family ceilings are **input** limits and are deliberately not compared
   against the upload ceiling: a 500 MB video that yields a 5 MB MP3 is the entire
   point of the tool.

2. **A family timeout above the job budget**, for video, PDF and QR:

   > `VIDEO_TOOL_TIMEOUT_MS=… exceeds TOOL_JOB_TIMEOUT_MS=…; the job would be abandoned while the tool was still working.`

3. **A queue lock that is not shorter than the longest tool step** — the longest
   of `VIDEO_TOOL_TIMEOUT_MS` and `PDF_TOOL_TIMEOUT_MS`:

   > `TOOL_QUEUE_LOCK_DURATION_MS=… is not shorter than the longest tool step (… ms). It is renewed while the processor runs, so it should be far smaller, not larger.`

4. **A render DPI whose A4 page exceeds the image pixel ceiling:**

   > `PDF_RENDER_DPI=… renders an A4 page at about … pixels, over IMAGE_TOOL_MAX_PIXELS=…; every rendered page would then be rejected.`

   An A4 page rendered at the configured DPI is what "PDF to images" actually
   produces, so if one page cannot pass the pixel ceiling, every rendered page is
   rejected — after the render has already been paid for.

5. **The two workspaces sharing a directory:**

   > `TOOL_WORKSPACE_DIR and DOWNLOAD_DIR are both "…". The two have independent cleanup sweeps, so sharing a directory means one can delete the other's in-flight files.`

---

## The toolchain probe

`probeToolchain` runs once at startup, before any queue is touched, and checks
seven things:

| Probe        | How                                      |
| ------------ | ---------------------------------------- |
| `ffmpeg`     | `-version`                               |
| `ffprobe`    | `-version`                               |
| `pdftocairo` | `-v`                                     |
| `pdfinfo`    | `-v`                                     |
| `libmp3lame` | `ffmpeg -hide_banner -encoders`, grepped |
| `sharp`      | a real 1×1 JPEG encode                   |
| `workspace`  | `access(dir, W_OK)`                      |

Presence of output is the honest signal rather than the exit code: `ffmpeg
-version` exits 0, but `pdfinfo -v` writes to stderr and exits 99 on some builds.

The last three are the interesting ones. `libmp3lame` is probed as an **encoder**
and not merely as a binary, because an FFmpeg built without it runs fine and then
fails every single "video to MP3" job with an error about an unknown encoder —
which reads as a bug in this code rather than a gap in the image. Sharp is
**loaded**, not imported: its native binding resolves lazily, so a musl/glibc
mismatch only surfaces on first use, and reading `sharp.versions` alone would
pass on a build whose binding cannot run.

**Any failure is fatal.** Unlike a missing cookie file there is no degraded mode
here: half the tools accepting work and failing every job is worse than not
accepting it. The process logs `toolchain component unusable` for each failure
and then refuses to start.

The probe is deliberately **not** part of the health endpoint. These are version
checks that fork processes, and running them every ten seconds would spend more
CPU on checking than on working. Startup is where they belong.

### The health endpoint

Port 3003 by default, same two paths as the other two processes. Readiness checks
**three** things and none of them is a binary:

```ts
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      healthCheck('workspace', () => container.workspaces.ensureRoot()),
    ],
```

So the three health ports are: bot **3001**, worker **3002**, tools worker
**3003**.

---

## What a tool job never carries

Four properties, each of which is a decision rather than an accident.

**Queue payloads and session state carry only Telegram file references.** No
path, no URL, no token. The worker resolves each file from its reference when it
runs, which is what keeps a bot token out of Redis. The payload is validated on
both sides — the bot builds it from a session it already trusts, and the worker
re-parses it on receipt, because a queue outlives a deployment and a job enqueued
by the previous release is the normal case during a rolling restart.

**QR content never reaches the database, the logs or the callback data.** It can
be a Wi-Fi password, a private URL or a home address. It exists in the queue for
as long as the job takes and nowhere else.

`tool_jobs.operation_payload` is an audit record with no expiry: it outlives the
job, the chat and — for a Wi-Fi key — very probably the network. Every tool but
QR stores dimensions, formats and quality settings, which are exactly what the
row exists to remember. QR is reduced to an **allow-list** of four fields —
`tool`, `kind`, `format`, `size`, `errorCorrection` — rather than having its
content deleted. The difference matters the day someone adds a field to the vCard
arm: with a deny-list it would silently start being persisted, and with an
allow-list the failure mode of forgetting is a missing column value rather than a
disclosed one. The kind is kept because without it the row cannot answer "what
did this job do", which is the whole point of keeping it.

**An unmodelled error message is replaced, not truncated.** Third-party output —
FFmpeg's stderr, a Poppler dump, an HTTP client echoing back a signed URL — goes
to the log, and the row gets `unmodelled failure; see the log for this request
id`. Truncating would not help: the interesting secrets are at the front.

**The tools image mounts no `./secrets`.** Cookie files exist for yt-dlp, and this
process never fetches from anywhere but Telegram.

---

## Operations

### The tables

`tool_jobs`, `tool_job_inputs` and `tool_job_events`, from
`infra/migrations/0002_add_tool_jobs.sql`.

`tool_key` and `status` are **TEXT, not PostgreSQL enums**, deliberately. Adding
a ninth tool would otherwise need a migration that rewrites a type, and this
project has already been bitten once by an enum value that existed in code and
not in the database. The application vocabulary plus a Zod check at the boundary
gives the same safety without the DDL.

### Maintenance

A plain interval, `TOOL_MAINTENANCE_INTERVAL_MS`, which runs once at startup so a
previous crash is cleared without waiting a full interval:

- **Orphaned workspaces** older than `TOOL_ORPHAN_WORKSPACE_MAX_AGE_HOURS`. Every
  job removes its own workspace in a `finally`, but a container killed mid-render
  never reaches that — and these directories hold decoded video frames, so the
  leak is measured in gigabytes per crash rather than kilobytes. The sweep is
  age-bounded so a workspace belonging to a job still running on another replica
  is never removed out from under it; a render may take half an hour, and the
  default age is six times that.
- **Stale jobs**, expired in batches. Without this they sit in `processing`
  forever, counting against their owner's active-job ceiling and locking that
  user out of the tools entirely.

### Cancellation

A cancel tap lands in the bot process, which publishes the job id on
`tgtools:tool:cancel`. The tools worker subscribes on a **second** Redis
connection — a client in subscriber mode refuses every other command — and the
replica holding that job aborts it. A failed publish is swallowed and logged:
the row has already been written, and turning a successful cancellation into an
error message would be a worse answer than a conversion that runs to completion
and is thrown away.

### Shutdown

All four workers are paused at once with `pause(false)`, which keeps current jobs
running while refusing new ones. Pausing them one at a time would let the image
queue pick up a new job while the video queue was still being asked to finish.
Then: maintenance loop, cancellation subscription, drain running jobs, close the
workers, health server, Redis subscriber, Redis, database.

The drain gives in-flight jobs `WORKER_SHUTDOWN_GRACE_MS`, then aborts them and
waits two seconds — a moment for the abort handlers to kill their child processes
and remove their workspaces before the connections close under them. Without it a
killed FFmpeg leaves its partial output behind for the maintenance sweep to find
hours later.

### Troubleshooting

| Symptom                                                                                                  | Cause                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools-worker` exits **78** immediately with `TOOLS_ENABLED is false, so this process has nothing to do` | Exactly what it says. Set `TOOLS_ENABLED=true` or stop running the service.                                                                                                |
| `fatal: tools-worker failed to start: … one or more native dependencies are unusable`                    | The toolchain probe failed. The `toolchain component unusable` lines above it name which. An image or deployment problem, not a user error.                                |
| Startup fails with `TOOLS_ENABLED is true but every family is switched off`                              | All four `*_TOOLS_ENABLED` are false, so no queue would be drained.                                                                                                        |
| `ConfigurationError: … is above the … MB this deployment can download from Telegram`                     | An input ceiling above the fetch ceiling — 20 MB on the public API. Lower it or run a local Bot API server.                                                                |
| `ConfigurationError: TOOL_WORKSPACE_DIR and DOWNLOAD_DIR are both …`                                     | The two sweeps would delete each other's in-flight files. Give the tools their own volume.                                                                                 |
| Jobs queue but never run                                                                                 | The family is disabled, so its queue has no consumer. Look for `tool family is disabled; its queue will not be drained`.                                                   |
| A job renders twice, `job stalled` warnings                                                              | `TOOL_QUEUE_LOCK_DURATION_MS` too low for a single step. BullMQ renews at half the duration, but only while the processor yields.                                          |
| Every "video to MP3" fails with an unknown-encoder error                                                 | An FFmpeg built without libmp3lame. The startup probe should have caught it — check the `libmp3lame` toolchain line.                                                       |
| `could not load the sharp module`                                                                        | A libc mismatch: glibc `node_modules` on a musl runtime, or the reverse. `Dockerfile.tools` uses `bookworm-slim` for exactly this reason.                                  |
| Disk on `tools-workspace` creeps up                                                                      | Orphan sweep not running, or `TOOL_ORPHAN_WORKSPACE_MAX_AGE_HOURS` too high. These directories hold decoded frames, so the leak is fast.                                   |
| `TELEGRAM_FILE_UNAVAILABLE` on every job in local mode                                                   | The Bot API volume is not mounted, or `TELEGRAM_LOCAL_FILE_ROOTS` does not contain the path the server reports. The compose file mounts it at `/var/lib/telegram-bot-api`. |
| `curl localhost:3003/health/ready` refused                                                               | Wrong port — the bot is 3001, the downloader worker 3002, and the tools worker 3003.                                                                                       |

---

## What has not been verified

Stated plainly, because the alternative is someone discovering it in production.

**FFmpeg and Poppler are not installed on the development machine.**
`FfmpegVideoProcessor` and `PopplerPdfProcessor.toImages()` have therefore never
been executed — not once, in any suite. What is covered is their pure planning
halves: `ffmpeg-plan.ts` and `pdf-plan.ts` have unit tests that assert the
argument vectors and the page-range arithmetic, and nothing has ever run those
arguments against the real binaries. `tests/integration/pdf-build.test.ts` says
so in its own header, and the startup toolchain probe is the check that would
catch a missing binary in a real deployment.

**Docker is not installed there either.** `Dockerfile.tools` has never been
built, and `docker compose config` has never been run. The compose file was
checked with a YAML parser only, which validates its syntax and says nothing
about whether the service starts, whether the volumes mount where they are
expected, or whether the build stages resolve.

**Sharp, `qrcode` and PDFKit are genuinely executed.** The integration suite runs
them for real: `tests/integration/image-tools.test.ts` against real Sharp with
fixtures generated at run time, `tests/integration/qr-tools.test.ts` against the
real `qrcode` encoder, and `tests/integration/pdf-build.test.ts` against real
PDFKit and real Sharp. Five of the eight tools therefore have their processing
half exercised; the two video tools and `pdf.to_images` do not.

**No Redis was available, so the BullMQ retry path has not been exercised end to
end.** The `queued`-rather-than-`failed` edge described above is covered by unit
tests over the transition table, and the agreement between what `handleFailure`
writes and what `shouldRethrow` returns has not been observed against a real
queue delivering a real second attempt.

**The bot-side entry point is not wired yet.** `apps/bot/package.json` does not
depend on `@tgtools/feature-tools`, and `apps/bot/src/register-features.ts`
registers only start, help and the downloader. Nothing in the codebase enqueues
onto `tool-image`, `tool-video`, `tool-pdf` or `tool-qr` — the only references to
those queue names outside `queue-names.ts` are the tools worker's own consumers.
The engine, the contracts, the persistence, the session store, the Persian
messages and the menu keyboards all exist and are unit-tested, and the worker
will drain a queue that something else fills; but as the tree stands, a user has
no way to reach any of it. `MAX_ACTIVE_TOOL_JOBS_PER_USER` is likewise read into
the config and not yet consulted by anything — `countActiveByUser` exists on the
repository port and has no caller.
