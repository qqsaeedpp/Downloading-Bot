# The downloader flow, step by step

What actually happens between a user pasting a link and receiving a file, and
why each step is where it is.

---

## Stage 1 — a message arrives

`features/downloader/src/presentation/telegram/handlers/link-message.handler.ts`

1. **Extract.** `extractUrls` finds `https://…` inside whatever the user typed.
   It strips the full stop that ended the sentence but keeps a closing paren
   that belongs to the path, and it flags a message beginning with `/` as a
   command — `/start https://t.me/…` is a deep link, not a download request.
2. **Nothing found** → a short Persian guide naming the supported platforms.
   Silence would be worse: the user has no way to know what went wrong.
3. **More than one link** → a note that only the first is taken. Phase one
   deliberately does not queue several at once.
4. **Send a placeholder** — `⏳ در حال بررسی لینک…` — and keep its `message_id`.
   Every later status update edits this one message rather than adding to the
   chat.

## Stage 2 — inspection

`application/use-cases/inspect-media.use-case.ts`

1. **Access check.** `canInspect` — a Redis fixed-window counter. Each
   inspection spawns a process and hits a third party, so it is cheap but not
   free.
2. **Create the job row _first_.** Before asking the extractor anything. The row
   is what the concurrency limit counts, what the callback data points at, and
   what a crash mid-inspection leaves behind for the sweeper to expire. Status:
   `pending` → `inspecting`.
3. **Resolve the URL.** `UrlGuard.parse` (see [security.md](./security.md)),
   then `RedirectResolver` for short links only. The guard hands back three
   URLs, and which one is used where matters: `originalUrl` is what the user
   sent (minus the fragment), `requestUrl` is what yt-dlp is given, and
   `normalizedUrl` is what gets hashed into the cache key. They differ only for
   a platform that defines a canonical shape — YouTube collapses `youtu.be`,
   `/shorts`, `/embed`, `/live`, `music.` and timestamp links onto
   `watch?v=<id>`, which is also how `list=` is dropped before the extractor
   ever sees it. A guard rejection here — unsupported platform, malformed URL,
   blocked address — is mapped through `toDomainError`, so the user gets the
   specific sentence rather than the generic one.
4. **Cache lookup**, keyed by SHA-256 of the normalised URL **and** whether the
   result needed authentication. Those are separate namespaces on purpose: an
   authenticated result may describe a post an anonymous visitor is not entitled
   to see.
5. **Ask the engine.** `--dump-single-json --skip-download
--ignore-no-formats-error`; the last flag lets an image-only pin return JSON
   instead of aborting with "No video formats found". This step runs `yt-dlp`
   through `execFile` directly rather than through `ytdlp-nodejs`, whose builders
   stat FFmpeg on construction and append `--ffmpeg-location` to every call.
   Inspection decodes nothing, so it must not depend on a binary the bot
   container has no reason to ship — which is why that container has none.
6. **Map and validate.** Raw JSON → Zod → `YtDlpInfoMapper` → domain `MediaInfo`.
   The schema is tolerant by design: every extractor returns a different subset
   and the set changes between releases, so unparsable _fields_ are dropped
   rather than failing the document. A single malformed format costs that
   format, not the other twenty.
7. **Derive the menu.** `listQualityOptions` returns real heights the source
   offers, minus any whose _declared_ size exceeds the ceiling. Unknown sizes
   are kept — Instagram and TikTok declare none, and excluding them would leave
   an empty keyboard.
8. Status → `awaiting_selection`, expiring at `DOWNLOAD_SELECTION_TTL_SECONDS`.

## Stage 3 — the card

`presentation/telegram/presenters/media-card.presenter.ts`

Title, platform, uploader, duration, view and like counts — each rendered only
if the platform supplied it. Pinterest has no duration and X has no view count;
a card that assumes otherwise shows `undefined` to a real person.

Buttons carry `dl:<shortId>:q:<optionId>` — under Telegram's 64-byte
`callback_data` cap, and containing nothing a crafted callback could use to
describe a download of its own.

## Stage 4 — a button is tapped

`application/use-cases/request-download.use-case.ts`

The callback query is answered **immediately** (Telegram gives roughly fifteen
seconds before the client shows an error), then:

| Guard                                       | Why it exists                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Job exists                                  | the card may outlive a database wipe                                         |
| `job.userId === actingUserId`               | in a group the card is visible to everyone                                   |
| `isSelectionStillValid`                     | rejects an expired card _and_ a replayed callback for a job that already ran |
| Option is still offered                     | the cached menu may have expired                                             |
| `canCreateDownload`                         | per-user concurrency                                                         |
| `updateSelection` with the expected version | **the double-tap guard** — the second tap loses the race and does nothing    |

Only then: status → `queued`, and the payload is enqueued with `jobId` as the
BullMQ job id, so the queue itself de-duplicates anything that slipped through.

Order matters here. Enqueuing before the row says `queued` leaves a window in
which the worker picks the job up, finds it still `awaiting_selection`, and
refuses it.

## Stage 5 — the worker

`application/use-cases/process-download.use-case.ts`

```
re-read the row
  completed?             → skip   (BullMQ can deliver the same job twice)
  cancelled / expired?   → skip
claim it: version-checked write → downloading
  lost the claim?        → skip   (another worker, or a cancel, got there first)

download
  ├─ per-job workspace (mkdtemp)
  ├─ size watchdog every 3 s
  ├─ progress → DB via ProgressWriter, → Telegram only when the throttler agrees
  ├─ ffprobe → planNormalization → remux or re-encode
  └─ thumbnail from ~10% in

→ processing → uploading → send → completed
finally: delete the workspace, always
```

**Progress throttling.** yt-dlp emits several samples a second. An edit needs
_both_ a minimum age (`PROGRESS_UPDATE_INTERVAL_MS`) and meaningful movement
(`PROGRESS_UPDATE_MIN_PERCENT`) — with two exceptions: the first sample always
renders, so the user sees something immediately, and the jump to 100% always
renders, so the bar never stops at 97%. Only the Telegram edit goes through the
throttler; the database write has its own machinery.

**Progress persistence.** The two halves are separate because they fail
differently: an expensive Telegram edit is worth rationing, and a cheap database
write must be incapable of harming the download. Every sample goes to
`ProgressWriter`, which:

- **Normalises it first.** `normalizeProgress` (`@tgtools/shared`) floors byte
  counts to integers, because yt-dlp divides a fragment count into an estimate
  and does not round — a Pinterest download reported
  `total_bytes = 1492973.3333333335`, and Postgres refused it for a `bigint`
  column. Anything unusable (`NaN`, infinite, negative, or a zero _total_, which
  means "unknown" rather than "empty") becomes `undefined`, or `0` for the
  downloaded count. Percent is clamped to 0..100 and derived from the byte counts
  whenever a total is known, because yt-dlp's own percentage comes from a
  different estimate than its byte counts and the two disagree often enough to
  make a bar jump backwards.
- **Coalesces the writes.** One UPDATE per sample meant dozens of overlapping
  writes against one row. At most one is in flight at a time now, and the newest
  pending sample wins — a sample that arrives mid-write replaces any earlier one
  still waiting. A sample that would move the bar backwards is dropped, unless
  `beginPhase()` has declared a legitimate restart (which is what the transition
  into `normalizing` does, since the byte counter restarts against a different
  total).
- **Swallows its own failures.** `submit()` returns immediately and never throws;
  a rejected write is logged and dropped. It is called from inside yt-dlp's
  progress callback, where an exception would propagate into the extractor, and
  the rejection used to reach `unhandledRejection` and take the worker down. See
  [error-model.md](./error-model.md).
- **Is closed on every exit path.** `close()` sits in the `finally` alongside the
  workspace cleanup, so the last useful state reaches the database before the job
  is marked completed and a finished, failed or cancelled job leaves nothing
  scheduled behind it.

**Version tracking.** The use case carries the version it holds in one variable
advanced by `#advance`, rather than writing `job.version + 1`, `+ 2` at each
call site. The arithmetic form breaks silently the moment a step is inserted —
which is exactly what happened when the `processing` state was added, and the
end-to-end test caught it.

## Stage 6 — delivery

`infrastructure/telegram/grammy-media-sender.ts`

| Type  | Method      | Attached                                                 |
| ----- | ----------- | -------------------------------------------------------- |
| video | `sendVideo` | `supports_streaming`, width, height, duration, thumbnail |
| audio | `sendAudio` | duration                                                 |
| image | `sendPhoto` | —                                                        |

Without width, height and duration Telegram shows a black box with a 00:00
timer instead of an inline player, even for a perfectly good H.264 file.

**The fallback.** Telegram accepts an upload and _then_ decides whether the
result is playable. When it refuses with an `unsupported_content` shape, the
bytes are fine and only the presentation was wrong — so the same file is
re-sent as a document rather than failing the job.

## Stage 7 — failure

Every failure becomes a `DownloadFailureCode`, and every code has a Persian
sentence. Raw yt-dlp or FFmpeg output never reaches the user, and never reaches
the database: the mapper keeps the last few `ERROR:` lines and clips them,
because yt-dlp echoes full request URLs — cookies included.

Retryable failures are **rethrown** so BullMQ can back off, leaving the row in
`downloading`. Writing `failed` there would make a retryable job look final to
both the user and the maintenance sweep.

## Stage 8 — housekeeping

A plain interval in the worker (`MAINTENANCE_INTERVAL_MS`), which:

- expires `awaiting_selection` rows nobody ever tapped — otherwise they sit
  forever counting against the user's limit;
- removes workspaces older than `ORPHAN_WORKSPACE_MAX_AGE_HOURS`, which the
  process-local cleanup could not reach because the process was gone.

Both halves are wrapped so that a failure logs and continues. Maintenance
falling over must never take the worker with it.
