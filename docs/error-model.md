# The error model

A failure travels through four vocabularies on its way from a yt-dlp exit code to a
Persian sentence:

```
yt-dlp stderr / Telegram 400 / Postgres error
        │
        │  YtDlpErrorMapper (pattern list)      ← packages/downloader-engine/src/errors/
        ▼
   EngineError { code: EngineFailureCode, retryable }
        │
        │  CODE_MAP + toDomainError()           ← features/downloader/src/infrastructure/providers/
        ▼
   DownloadError { code: DownloadFailureCode, retryable }
        │
        ├─► retryable  → rethrown → BullMQ retries with exponential backoff
        └─► permanent  → row set to `failed` → reporter.onFailed(code)
                                                     │
                                                     │  fa.failure(code)
                                                     ▼
                                              a Persian sentence
```

Each hop narrows: the engine distinguishes a geo-block from a missing format, and
the product does not — both mean "we cannot get this for you". The mapping is
written out in full rather than passed through, so neither side can drag the other
along when it changes.

---

## `AppError` — the root

`packages/shared/src/errors/app-error.ts`:

```ts
export abstract class AppError extends Error {
  abstract readonly code: string;

  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.context = options.context ?? {};
    Error.captureStackTrace(this, new.target);
  }
}
```

Every deliberate error in the codebase extends it. The point of the abstract `code`
is that callers branch on a stable string rather than on a message a library upgrade
may reword. `context` is serialised verbatim by the logger, so _"must never carry a
secret"_.

Direct subclasses in `@tgtools/shared`:

| Class                          | `code`                      | Meaning                                                                          |
| ------------------------------ | --------------------------- | -------------------------------------------------------------------------------- |
| `InvariantViolationError`      | `INVARIANT_VIOLATION`       | A bug: a state the code claimed was impossible. Thrown by `assertNever`.         |
| `ConfigurationError`           | `CONFIGURATION_ERROR`       | Config or wiring is wrong; the process cannot usefully continue.                 |
| `OperationCancelledError`      | `OPERATION_CANCELLED`       | A user tap or a shutdown.                                                        |
| `OperationTimeoutError`        | `OPERATION_TIMEOUT`         | Ran past its budget. Carries `timeoutMs` and a label.                            |
| `InvalidStatusTransitionError` | `INVALID_STATUS_TRANSITION` | The download job state machine refused a move. Lives in the downloader's domain. |

Two error types deliberately sit outside the hierarchy, because they are caught by
`instanceof` at a single call site and never need a code: `PathEscapeError`
(`packages/shared/src/fs/path-safety.ts`) and `ProcessFailedError` /
`YtDlpProcessError` in the engine's process layer, which carry an exit code, a
signal and stderr straight into `YtDlpErrorMapper`.

Two helpers matter downstream. `describeError(value)` produces log text from an
`unknown` without stringifying an object into `[object Object]`; its docstring is
explicit that it is _"Message text for a log line, never for a user."_
`assertNever(value, what)` proves a switch covered a union and throws
`InvariantViolationError` if it did not.

---

## `EngineError` — the technical vocabulary

`packages/downloader-engine/src/errors/engine-error.ts`. Eighteen codes; nothing
here is ever shown to a user, so _"the names optimise for precision rather than
tone"_.

```
INVALID_URL            UNSUPPORTED_PLATFORM   UNSUPPORTED_MEDIA
PRIVATE_MEDIA          LOGIN_REQUIRED         MEDIA_NOT_FOUND
FORMAT_UNAVAILABLE     MEDIA_TOO_LARGE        GEO_RESTRICTED
RATE_LIMITED           DOWNLOAD_TIMEOUT       PROCESSING_TIMEOUT
DOWNLOAD_FAILED        PROCESSING_FAILED      CANCELLED
TOOLCHAIN_MISSING      INSUFFICIENT_STORAGE   INTERNAL_ERROR
```

`retryable` defaults from a set:

```ts
const DEFAULT_RETRYABLE: ReadonlySet<EngineFailureCode> = new Set([
  EngineFailureCode.DownloadTimeout,
  EngineFailureCode.ProcessingTimeout,
  EngineFailureCode.DownloadFailed,
  EngineFailureCode.ProcessingFailed,
  EngineFailureCode.RateLimited,
]);
```

and can be overridden per instance. The comment states the cost of getting it
wrong in either direction: _"retrying a permanent failure burns a worker slot and
hammers an extractor that already said no, while not retrying a transient one loses
a job to a single dropped packet."_

---

## `DownloadError` — the product vocabulary

`features/downloader/src/domain/errors/download-error.ts`. Eighteen codes again,
but a different eighteen — `GEO_RESTRICTED`, `TOOLCHAIN_MISSING` and
`INSUFFICIENT_STORAGE` are gone; `UPLOAD_FAILED`, `JOB_CANCELLED`,
`TOO_MANY_ACTIVE_JOBS` and `SELECTION_EXPIRED` are new.

```ts
export class DownloadError extends AppError {
  readonly code: DownloadFailureCode;
  readonly retryable: boolean;

  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
    this.retryable = options.retryable ?? !isPermanentFailure(code);
  }
```

Retry disposition is the _inverse_ of a permanence set here:

```ts
export const PERMANENT_FAILURE_CODES: ReadonlySet<DownloadFailureCode> = new Set([
  DownloadFailureCode.InvalidUrl,
  DownloadFailureCode.UnsupportedPlatform,
  DownloadFailureCode.UnsupportedMedia,
  DownloadFailureCode.PrivateMedia,
  DownloadFailureCode.LoginRequired,
  DownloadFailureCode.MediaNotFound,
  DownloadFailureCode.FormatUnavailable,
  DownloadFailureCode.MediaTooLarge,
  DownloadFailureCode.JobCancelled,
  DownloadFailureCode.TooManyActiveJobs,
  DownloadFailureCode.SelectionExpired,
]);
```

`DownloadError` also carries named constructors for the failures the feature raises
itself, with no engine involved: `invalidUrl()`, `unsupportedPlatform()`,
`selectionExpired()`, `tooManyActiveJobs(limit)`, `internal(message, cause)`.

`toDownloadError(error)` is the last-resort narrowing — _"An error that reaches the
presentation layer without a code is a bug, but the user still deserves a sentence
rather than a silence."_

---

## The mapping table

`features/downloader/src/infrastructure/providers/engine-media-downloader.adapter.ts`.
The `Readonly<Record<EngineFailureCode, DownloadFailureCode>>` type makes this
exhaustive: adding an engine code without a mapping is a compile error.

| `EngineFailureCode`    | → `DownloadFailureCode` |
| ---------------------- | ----------------------- |
| `INVALID_URL`          | `INVALID_URL`           |
| `UNSUPPORTED_PLATFORM` | `UNSUPPORTED_PLATFORM`  |
| `UNSUPPORTED_MEDIA`    | `UNSUPPORTED_MEDIA`     |
| `PRIVATE_MEDIA`        | `PRIVATE_MEDIA`         |
| `LOGIN_REQUIRED`       | `LOGIN_REQUIRED`        |
| `MEDIA_NOT_FOUND`      | `MEDIA_NOT_FOUND`       |
| `FORMAT_UNAVAILABLE`   | `FORMAT_UNAVAILABLE`    |
| `MEDIA_TOO_LARGE`      | `MEDIA_TOO_LARGE`       |
| `GEO_RESTRICTED`       | **`UNSUPPORTED_MEDIA`** |
| `RATE_LIMITED`         | `RATE_LIMITED`          |
| `DOWNLOAD_TIMEOUT`     | `DOWNLOAD_TIMEOUT`      |
| `PROCESSING_TIMEOUT`   | `PROCESSING_TIMEOUT`    |
| `DOWNLOAD_FAILED`      | `DOWNLOAD_FAILED`       |
| `PROCESSING_FAILED`    | `PROCESSING_FAILED`     |
| `CANCELLED`            | **`JOB_CANCELLED`**     |
| `TOOLCHAIN_MISSING`    | **`INTERNAL_ERROR`**    |
| `INSUFFICIENT_STORAGE` | **`INTERNAL_ERROR`**    |
| `INTERNAL_ERROR`       | `INTERNAL_ERROR`        |

The four bolded rows are the collapses. A geo-block and an unsupported format read
identically to a user. A missing FFmpeg and a full disk are operator problems, not
user problems, so both become the generic `INTERNAL_ERROR` — and both are visible
in the logs with their original engine code, because `cause` is preserved.

`toDomainError` is the only entry point:

```ts
export function toDomainError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  if (error instanceof EngineError) {
    return new DownloadError(CODE_MAP[error.code], error.message, {
      cause: error,
      retryable: error.retryable,
    });
  }
  return DownloadError.internal(error instanceof Error ? error.message : String(error), error);
}
```

Note `retryable: error.retryable` — **the engine's disposition wins**, overriding
the domain default derived from `PERMANENT_FAILURE_CODES`. That is what keeps
`TOOLCHAIN_MISSING` and `INSUFFICIENT_STORAGE` from becoming retryable just because
they land on `INTERNAL_ERROR`, which is not in the permanent set. It also makes
`GEO_RESTRICTED → UNSUPPORTED_MEDIA` consistent (neither is retryable).

### The path that used to miss the table

`toDomainError` is the only entry point, and everything must actually go through
it. The URL guard is the one place the engine is called _without_ passing through
`EngineMediaDownloader`, and for a while it did not: `resolveUrl` in
`features/downloader/src/downloader.feature.ts` let the guard's `EngineError`
propagate, `toDownloadError` did not recognise it, and it was narrowed to
`INTERNAL_ERROR` as a last resort.

The effect was invisible in the logs and very visible to users. Every rejected
link — an unsupported platform, a malformed URL, a blocked address — arrived as
"⚠️ مشکلی پیش آمد" ("something went wrong, try again shortly") instead of the
specific sentence written for it. Worse, `INTERNAL_ERROR` is retryable, so a
permanently invalid URL looked like a transient fault.

Both the guard and the redirect resolver are now wrapped:

```ts
let safe;
try {
  safe = options.engine.urlGuard.parse(rawUrl);
} catch (error: unknown) {
  throw toDomainError(error);
}
```

which is what makes `INVALID_URL` and `UNSUPPORTED_PLATFORM` reachable at all. The
general rule: an `EngineError` crossing into the feature must pass through
`toDomainError`, and a `catch` that does not call it is a bug even when the code
compiles.

---

## Classifying yt-dlp stderr

`packages/downloader-engine/src/errors/ytdlp-error-patterns.ts` is the only place
in the codebase that reads yt-dlp's prose, because _"yt-dlp reports almost
everything as exit code 1 with a prose message"_.

### Order is significant

The file's header says so in capitals:

> ORDER IS SIGNIFICANT: the first match wins. Several of these messages share
> phrases — "not available" appears in a geo-block, a deleted post and a missing
> format — so the specific entries come first and the general ones last. Getting
> the order wrong does not fail anything loudly; it just tells the user "this post
> was deleted" when the real answer was "that quality is gone, pick another".

The concrete case is in a comment on the `FORMAT_UNAVAILABLE` entry, which sits at
index 3 while `MEDIA_NOT_FOUND` sits at index 6:

```ts
  {
    // Ahead of MEDIA_NOT_FOUND: "Requested format is not available" contains
    // "not available", and reporting it as a deleted post sends the user away
    // instead of back to the keyboard to pick another quality.
    code: EngineFailureCode.FormatUnavailable,
    pattern:
      /requested format (?:is )?not available|no video formats found|no formats found|no video could be found|requested format is not available/i,
```

`MEDIA_NOT_FOUND`'s pattern ends in a bare `|not found`, which would swallow it.
The user-visible difference: `FORMAT_UNAVAILABLE` renders _"کیفیت انتخاب‌شده دیگر در
دسترس نیست. لطفاً دوباره لینک را بفرستید."_ ("that quality is gone, send the link
again"), while `MEDIA_NOT_FOUND` renders _"این پست پیدا نشد. ممکن است حذف شده
باشد."_ ("this post was not found; it may have been deleted") — one sends them back
to the keyboard, the other sends them away.

The full order:

1. `LOGIN_REQUIRED` — auth walls from all three platforms funnel into these phrasings.
2. `PRIVATE_MEDIA` — content exists, owner limited who may see it.
3. `GEO_RESTRICTED` — a different exit node would help; another attempt from here would not.
4. `FORMAT_UNAVAILABLE` — ahead of `MEDIA_NOT_FOUND`, per above.
5. `MEDIA_TOO_LARGE` — yt-dlp's own `--max-filesize` refusal.
6. `RATE_LIMITED` — 429 / "too many requests".
7. `MEDIA_NOT_FOUND` — deleted or never existed; also the generic `not found`.
8. `UNSUPPORTED_PLATFORM` — no extractor claimed the URL, whatever our registry believed.
9. `INSUFFICIENT_STORAGE` — "no space left on device".
10. `TOOLCHAIN_MISSING` — a misconfigured image, not a media problem.
11. `DOWNLOAD_TIMEOUT` — network stalled.
12. `DOWNLOAD_FAILED` — transport-level, generally transient.

Every entry carries a `reason` field explaining _why_ the phrase means that code —
"the part a future reader cannot guess". Every entry has a unit test in
`ytdlp-error-mapper.test.ts`.

### Signals outrank text

`YtDlpErrorMapper.map` uses, in decreasing order of trust: how the process ended,
then the exit code, then the message.

```ts
    if (failure.cause instanceof OperationTimeoutError) { … DownloadTimeout … }
    if (failure.cause instanceof EngineError) return failure.cause;
    if (failure.cause instanceof OperationCancelledError) { … Cancelled … }

    for (const { code, pattern } of YTDLP_ERROR_PATTERNS) { … }

    // SIGKILL with nothing useful on stderr is what an OOM kill looks like.
    if (failure.signal === 'SIGKILL' || failure.signal === 'SIGTERM') { … DownloadFailed, retryable: true … }
```

If _we_ killed the process, the abort reason already encodes which watchdog did so,
and that is more reliable than whatever yt-dlp managed to print. `failure.cause
instanceof EngineError` is how the size watchdog's `INSUFFICIENT_STORAGE`-style
aborts survive intact.

### Stale sessions

A separate list, `STALE_SESSION_PATTERNS`, drives `withStaleCookieRetry`. It
overlaps with `LOGIN_REQUIRED` but is not the same thing — it also matches
`http error 40[13]` and `http error 404`, because _"a stale session is worse than no
session at all — Instagram answers an invalidated `sessionid` with a flat 404 on a
reel that resolves fine anonymously"_. See `docs/adding-a-platform.md` §1 for the
`retryWithoutCookies` policy flag that gates it.

---

## Telegram errors

`packages/telegram/src/telegram-errors.ts`. Telegram signals most of its
distinctions in a free-text `description` rather than an error code, so string
matching is unavoidable — _"It is confined to this one function, and covered by unit
tests, so the rest of the codebase never has to know that."_

| `TelegramErrorKind`   | Trigger                                                                         | `retryable` |
| --------------------- | ------------------------------------------------------------------------------- | ----------- |
| `network`             | `HttpError` — the request never reached Telegram                                | ✅          |
| `rate_limited`        | `error_code === 429`; carries `parameters.retry_after`                          | ✅          |
| `server`              | `error_code >= 500`                                                             | ✅          |
| `not_modified`        | "message is not modified"                                                       | ❌          |
| `message_unavailable` | "message to edit not found", "message can't be edited", …                       | ❌          |
| `blocked_by_user`     | "bot was blocked by the user", "user is deactivated"                            | ❌          |
| `chat_not_found`      | "chat not found"                                                                | ❌          |
| `file_too_large`      | "file is too big", "request entity too large", "file too large"                 | ❌          |
| `unsupported_content` | "wrong file identifier", "wrong type of the web page content", "unsupported", … | ❌          |
| `bad_request`         | any other `GrammyError`                                                         | ❌          |
| `unknown`             | not a grammY error at all                                                       | ❌          |

Two of these encode product decisions:

- **`not_modified` is not a failure.** Editing a message to the text it already has
  is the progress throttler doing its job. _"Treating it as one produces a permanent
  error log for every idle progress tick."_
- **`unsupported_content` is recoverable.** Telegram accepted the bytes and refused
  to treat them as playable media. `GrammyMediaSender` re-sends the same file as a
  document:
  ```ts
      if (info.kind === 'unsupported_content' && command.type !== DownloadType.Image) {
        this.options.logger.warn('telegram refused the typed send; retrying as a document', …);
        return this.#sendAsDocument(command);
      }
  ```

Everything else becomes a `DownloadError`: `file_too_large` → `MEDIA_TOO_LARGE`,
otherwise `UPLOAD_FAILED` carrying `retryable: info.retryable`. Note that grammY's
`autoRetry` (configured in `bot-factory.ts` with `maxRetryAttempts: 3`,
`maxDelaySeconds: 30`) has already waited out 429s before we see them —
_"anything still retryable here is worth a job retry."_

---

## What retryable actually does

`ProcessDownloadUseCase.#handleFailure` is where the disposition becomes behaviour.

**Cancelled** (`isCancellation(error)`, or code `JOB_CANCELLED`, or the worker's
signal aborted): the row moves to `cancelled`, the use case returns `'cancelled'`.
No `onFailed` message — the cancel handler already told the user. BullMQ sees a
resolved promise and marks the job complete.

**Retryable:**

```ts
if (downloadError.retryable) {
  // Leave the row in `downloading` and let BullMQ's backoff bring it back.
  // Writing `failed` here would make a retryable job look final to the user
  // and to the maintenance sweep.
  return 'rethrow';
}
```

`execute` then does `throw toDownloadError(error)`. BullMQ counts the attempt and
re-queues under `defaultJobOptions`:

```ts
    attempts: config.queue.attempts,              // DOWNLOAD_JOB_ATTEMPTS, default 2
    backoff: { type: 'exponential', delay: config.queue.backoffMs },  // default 5000 ms
```

When the attempt budget is exhausted the job lands in BullMQ's failed set and the
row is left in `downloading` — the maintenance sweep and the per-user active-job
count are what eventually notice.

**Permanent:** the row moves to `failed` with `errorCode` and a truncated
`errorMessageSafe`, `reporter.onFailed(code)` renders the Persian sentence, and the
use case returns `'skipped'`. BullMQ sees a _resolved_ promise, so there is no
retry.

In both cases a `failed` event is recorded first, so the audit trail survives even
when the row does not move.

### A failed progress write is deliberately not a failure

`ProgressWriter`
(`features/downloader/src/application/services/progress-writer.ts`) catches every
error its `update` call produces, logs it at `warn` with the job id, the request id
and the normalised values, and **never rethrows**:

```ts
      .catch((error: unknown) => {
        this.options.logger.warn('failed to persist download progress', { … });
      })
```

This is not defensiveness for its own sake. The write used to be passed to `void`,
so a rejected UPDATE reached `process.on('unhandledRejection')` — which the
shutdown handler correctly treats as fatal. One cosmetic progress row therefore
killed a worker mid-job, on a download that had otherwise succeeded. (The rejection
itself came from yt-dlp reporting `total_bytes = 1492973.3333333335` into a
`bigint` column; `normalizeProgress` now floors it, but the rule stands
independently of that particular sample.)

The trade is stated in the class docstring: _"Progress is advisory. Losing a sample
costs a stale percentage for a few seconds; losing the job costs the user their
file."_ Nothing in the download path branches on whether the write succeeded, and
`submit()` returns immediately rather than being awaited, so a slow database
cannot pace the download either.

---

## From a code to a Persian sentence

`features/downloader/src/presentation/telegram/messages/fa.ts` — _"Every string a
user can see, in one file."_

```ts
  failure(code: DownloadFailureCode): string {
    switch (code) {
      case DownloadFailureCode.InvalidUrl:
        return '❌ این لینک معتبر نیست. لطفاً آدرس کامل پست را بفرستید.';
      …
      default:
        return assertNever(code, 'download failure code');
    }
  },
```

The `assertNever` default makes the switch exhaustive at compile time, so _"a new
failure code cannot reach production without someone deciding what to tell the
person waiting for their file."_ `fa.test.ts` guards the runtime half — every code
must produce a message longer than ten characters, and none may contain `yt-dlp`,
`ffmpeg`, `ffprobe`, `undefined`, `NaN`, `Error:` or `stderr`.

Callers: `createLinkMessageHandler` (inspection failures) and
`TelegramProgressReporter.onFailed` (job failures), both via `toDownloadError`.

---

## Raw tool output never reaches a user or the database

Four independent controls:

1. **`summarise()`** in `ytdlp-error-mapper.ts`, applied to every `EngineError`
   message built from stderr:
   ```ts
   function summarise(stderr: string): string {
     const lines = stderr
       .split(/\r?\n/)
       .map((line) => line.trim())
       .filter((line) => line !== '');
     const errorLines = lines.filter((line) => /^(ERROR|WARNING):/i.test(line));
     const chosen = (errorLines.length > 0 ? errorLines : lines).slice(-3).join(' | ');
     return chosen.length > 400 ? `${chosen.slice(0, 399)}…` : chosen;
   }
   ```
   Its docstring gives the reason: _"yt-dlp's stderr can run to megabytes of
   warnings, and it echoes full request URLs — cookies included — which must not end
   up in a stored error field."_
2. **`truncateForStorage(text, max)`** (`packages/shared/src/privacy/redact.ts`)
   collapses all whitespace and clips with an ellipsis. `ProcessDownloadUseCase`
   applies it at 300 characters to both the event payload and `errorMessageSafe`:
   ```ts
       payload: {
         code: downloadError.code,
         message: truncateForStorage(downloadError.message, 300),
       },
   ```
3. **`sanitizePayload()`** in `drizzle-download-event.repository.ts` bounds the JSONB
   column independently: max 20 keys, strings truncated at 300, and objects, arrays
   and functions dropped rather than flattened.
4. **The presentation layer never sees a message at all.** `fa.failure()` takes a
   _code_, not a string. Whatever the underlying tool printed, the worst a user can
   see is a sentence from that table.

Logs are the one place the raw failure is allowed to appear, and even there:
`createLogger` redacts a path list (`token`, `cookies`, `DATABASE_URL`, …), runs
`scrubText` over every message to catch bot tokens and URL credentials in free text,
and `redactUrl` is used wherever a media URL is logged.

---

## Domain codes, end to end

`retryable` below is the default from `PERMANENT_FAILURE_CODES`; an engine-sourced
error may override it as described above. "User sees" is a translation of the
Persian in `fa.failure()`.

| `DownloadFailureCode`  | Retryable? | User-facing meaning                                                             |
| ---------------------- | ---------- | ------------------------------------------------------------------------------- |
| `INVALID_URL`          | no         | "This link is not valid. Please send the full post address."                    |
| `UNSUPPORTED_PLATFORM` | no         | "This link is not supported. Instagram, TikTok, Pinterest and X are supported." |
| `UNSUPPORTED_MEDIA`    | no         | "No downloadable content was found at this link." (also where geo-blocks land)  |
| `PRIVATE_MEDIA`        | no         | "🔒 This content is private and cannot be fetched."                             |
| `LOGIN_REQUIRED`       | no         | "🔒 This content is private or requires signing in to view."                    |
| `MEDIA_NOT_FOUND`      | no         | "This post was not found. It may have been deleted."                            |
| `FORMAT_UNAVAILABLE`   | no         | "The selected quality is no longer available. Please send the link again."      |
| `MEDIA_TOO_LARGE`      | no         | "📦 This file is larger than the limit for sending on Telegram."                |
| `DOWNLOAD_TIMEOUT`     | **yes**    | "⌛️ The download took too long. Try again shortly."                             |
| `PROCESSING_TIMEOUT`   | **yes**    | "⌛️ Preparing the file took too long. Try again shortly."                       |
| `DOWNLOAD_FAILED`      | **yes**    | "⚠️ Fetching the media is not possible right now. Try again shortly."           |
| `PROCESSING_FAILED`    | **yes**    | "⚠️ Preparing the file ran into a problem. Try again shortly."                  |
| `UPLOAD_FAILED`        | **yes**    | "⚠️ Sending the file to Telegram did not succeed. Try again shortly."           |
| `JOB_CANCELLED`        | no         | "✖️ The request was cancelled."                                                 |
| `RATE_LIMITED`         | **yes**    | "🚦 You have made too many requests. Wait a little and try again."              |
| `TOO_MANY_ACTIVE_JOBS` | no         | "🚦 You have several active downloads. Please wait for them to finish."         |
| `SELECTION_EXPIRED`    | no         | "⌛️ This request has expired. Please send the link again."                      |
| `INTERNAL_ERROR`       | **yes**    | "⚠️ Something went wrong. Try again shortly."                                   |

`SELECTION_EXPIRED` is also what a tap from someone else in a group produces.
`RequestDownloadUseCase` raises it for three distinct situations — an unknown short
id, a card owned by another user, and a card past its TTL — which keeps the
ownership refusal indistinguishable from an expiry:

```ts
    const job = await deps.jobs.findByShortId(command.shortId);
    if (job === undefined) throw DownloadError.selectionExpired();

    // Ownership, not just existence. In a group chat the card is visible to
    // everyone, and without this anyone could spend another person's quota.
    if (job.userId !== command.actingUserId) {
```
