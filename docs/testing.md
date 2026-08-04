# Testing

Everything runs on Vitest 4, straight from TypeScript source with no build step.
There is one config file, `vitest.config.ts`, defining four projects.

## The four projects

| Project       | Command                    | Files                                                        | Timeouts           |
| ------------- | -------------------------- | ------------------------------------------------------------ | ------------------ |
| `unit`        | `npm test`                 | `packages/*/src/**/*.test.ts`, `features/*/src/**/*.test.ts` | Vitest defaults    |
| `integration` | `npm run test:integration` | `tests/integration/**/*.test.ts`                             | 60 s test and hook |
| `e2e`         | `npm run test:e2e`         | `tests/e2e/**/*.test.ts`                                     | 60 s test and hook |
| `smoke`       | `npm run test:smoke`       | `tests/smoke/**/*.test.ts`                                   | 180 s test         |

The exact scripts in the root `package.json`:

```json
    "test": "vitest run --project unit",
    "test:watch": "vitest --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "vitest run --project e2e",
    "test:all": "vitest run",
    "test:smoke": "vitest run --project smoke",
    "test:coverage": "vitest run --project unit --coverage",
```

`npm test` is the unit project only. `npm run test:all` runs every project
including `smoke` — but `smoke` self-skips without `RUN_SMOKE_TESTS=1`, so in
practice `test:all` means unit + integration + e2e.

Coverage (`test:coverage`) is v8, reporting `text` and `lcov`, over
`packages/*/src/**/*.ts` and `features/*/src/**/*.ts`, excluding `**/*.test.ts`,
`**/index.ts` and `**/*.d.ts`. There is no threshold configured.

CI (`.github/workflows/ci.yml`) runs `lint` → `format:check` → `check-types` →
`test` → `test:e2e` → `test:integration` → `build`, in that order, on every push
and pull request.

**Unit tests live next to the source they cover.** `features/downloader/src/domain/entities/job-status.test.ts`
sits beside `job-status.ts`. Anything that spans packages — a whole flow, a real
filesystem, the network — lives under `tests/`.

---

## Why the config has a resolver plugin

`tsconfig.base.json` sets `"module": "NodeNext"`, so every relative import in the
sources carries a `.js` extension:

```ts
import { fa } from './presentation/telegram/messages/fa.js';
```

That file does not exist on disk until `tsc` runs. Vitest reads the source tree, so
without help every such import would 404. Hence:

```ts
const resolveTsFromJs: Plugin = {
  name: 'tgtools:resolve-ts-from-js',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = resolve(dirname(importer), `${source.slice(0, -'.js'.length)}.ts`);
    return existsSync(candidate) ? candidate : null;
  },
};
```

It only rewrites _relative_ `.js` specifiers, and only when the sibling `.ts`
actually exists — so a genuine `.js` file still resolves normally.

The second half is workspace aliasing. Tests import `@tgtools/feature-downloader`,
which npm resolves to `features/downloader/dist/index.js` — a stale build, or none
at all. `workspaceAliases()` scans `packages/` and `features/` for a
`package.json` + `src/index.ts` pair and points each package name at the source:

```ts
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
if (manifest.name !== undefined) aliases[manifest.name] = sourceEntry;
```

Together these mean **the suite never needs `npm run build` first**, and it always
tests the source you just edited rather than whatever `dist/` happens to hold.

`tests/tsconfig.json` mirrors the same aliases in its `paths` map so that
`npm run check-types` (which ends with `tsc -p tests/tsconfig.json`) sees the same
graph. That map is **manual** — a new workspace has to be added there by hand, even
though `vitest.config.ts` picks it up automatically.

---

## The fakes in `tests/support/` and the fixtures in `tests/fixtures/`

Three files of fakes, shared by the integration and e2e suites, plus one file of
captured extractor output.

### `in-memory-repositories.ts`

`InMemoryDownloadJobRepository`, `RecordingEventRepository`, `InMemoryInspectionCache`.

The design decision worth knowing is in the first one's docstring:

> An in-memory `DownloadJobRepository` that keeps the two behaviours the use cases
> actually depend on: the state machine refuses an illegal transition, and every
> conditional write asserts the version it read.
>
> Without both, an end-to-end test would pass against a fake that cannot reproduce
> the races the real one exists to prevent.

Concretely, `updateStatus` does exactly what the Drizzle repository does:

```ts
  updateStatus(input: UpdateJobStatusInput): Promise<boolean> {
    const job = this.#byId.get(input.jobId);
    if (job === undefined || job.version !== input.expectedVersion) return Promise.resolve(false);
    assertTransition(job.status, input.status);
    …
      version: job.version + 1,
```

It imports the _real_ `assertTransition` from `@tgtools/feature-downloader`, and it
returns `false` — not throws — on a version mismatch, which is the signal
`ProcessDownloadUseCase` branches on when it decides "another actor moved it first".
That is what lets `download-flow.test.ts` genuinely assert idempotency on a
redelivered job.

It also exposes `peek(jobId)` as a test helper for reading the row without going
through the port.

### `fakes.ts`

`FakeQueue` (records `enqueued`/`removed`, `next()` returns the message a worker
would receive), `FakeCancellationBus` (records `published`, delivers synchronously
to a subscribed handler), `FakeSender` (records `sent`, `failWith` to force a
failure), `RecordingReporter` (records `stages`, `progress`, `failures`,
`completed`), `AllowAllAccessPolicy` (three mutable booleans), and
`ScriptedDownloader`.

`ScriptedDownloader` is the interesting one — _"a downloader that produces whatever
the test asks for, without a process, a network or a disk"_. Set `inspectResult` or
`downloadResult` to a value or an `Error`; set `progressSamples` to drive the
throttler; set `waitForAbort = true` to make the download hang until the context
signal fires. Its `cleanedUp` counter is called out as the assertion that matters
most: _"a job must remove its workspace on every path, including the ones that
failed."_

### `media-fixtures.ts`

`VIDEO_OPTIONS` (1080p / 720p / 192 kbps), `IMAGE_OPTION`, `instagramReelInfo(overrides)`
and `pinterestPinInfo()` — fully-populated `MediaInfo` values so a test does not
have to hand-build twenty fields.

### `tests/fixtures/x-posts.ts`

A different kind of fixture: **sanitised `yt-dlp --dump-single-json` output**,
captured from the real extractors and stripped of identifying detail.
`X_VIDEO_POST`, `X_GIF_POST` (video track, no audio), `X_SINGLE_PHOTO_POST`,
`X_MULTI_PHOTO_POST`, `X_TEXT_ONLY_POST`, `X_MIXED_MEDIA_POST` and
`YOUTUBE_VIDEO`.

The point is stated in the file header: the deterministic suite must not depend on
live URLs, because a tweet can be deleted, protected or rate-limited, and a test
that goes red for those reasons stops meaning anything. Where `media-fixtures.ts`
gives you a domain object, these give you the raw document the mapper has to cope
with — which is the only way to test classification decisions against shapes the
extractor really produces.

---

## What each major test file covers

### Unit — `packages/`

| File                                                      | Covers                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/async/cancellation.test.ts`                   | `createAbortScope` (parent + timeout composition, cleanup), `delay`, `isTimeoutAbort`, `isCancellation`, `throwIfAborted`.                                                                                                                                                 |
| `shared/src/format/units.test.ts`                         | `formatBytes`, `formatDuration`, `renderProgressBar`, the MB↔bytes conversions.                                                                                                                                                                                            |
| `shared/src/fs/path-safety.test.ts`                       | `isPathInside` — the containment check behind `assertContainedPath`.                                                                                                                                                                                                       |
| `shared/src/fs/sanitize-filename.test.ts`                 | `sanitizeFilename` and `truncateToBytes` against hostile remote titles.                                                                                                                                                                                                    |
| `shared/src/privacy/redact.test.ts`                       | `redactUrl`, `stripUrlQuery`, `hashUrl`, `truncateForStorage`.                                                                                                                                                                                                             |
| `shared/src/media/progress.test.ts`                       | `normalizeProgress`: flooring the fractional total that crashed a worker, `NaN`/infinite/negative counts, a zero total meaning "unknown", and percent clamped to 0..100 and derived from the byte counts.                                                                  |
| `config/src/load-config.test.ts`                          | The whole config surface: the fully-defaulted object, MB→byte conversion, every `assertCoherent` rule, boolean parsing, cookie-path mapping, enum rejection. Includes a regression guard that the shipped defaults actually boot.                                          |
| `database/src/schema/vocabulary.test.ts`                  | Drift guard: the three `pgEnum`s must match the shared vocabulary exactly, have no duplicates, and be named after the type they create.                                                                                                                                    |
| `telegram/src/html.test.ts`                               | `escapeHtml`, `clampText`, `clampCaption`/`clampMessage`.                                                                                                                                                                                                                  |
| `telegram/src/telegram-errors.test.ts`                    | Every `TelegramErrorKind` branch and `isRetryableTelegramError`.                                                                                                                                                                                                           |
| `downloader-engine/src/security/url-guard.test.ts`        | Accepted links, **host confusion**, **SSRF surface**, supported-host-but-unsupported-path, and `normalizeUrl`.                                                                                                                                                             |
| `downloader-engine/src/security/ip-rules.test.ts`         | `inspectIpAddress` across the private/link-local/reserved ranges.                                                                                                                                                                                                          |
| `downloader-engine/src/platforms/youtube.test.ts`         | Every accepted YouTube shape, host confusion (`youtube.com.evil.example`, `notyoutube.com`), and canonicalisation: eight URLs for one video collapsing to one cache key, a timestamp kept out of the identity, and a playlist link resolving to the single video it names. |
| `downloader-engine/src/security/url-extractor.test.ts`    | Pulling URLs out of message text: trailing-punctuation trimming (a full stop vs a closing paren that belongs to the path), first-seen order and de-duplication, and the `isCommand` flag that stops `/start https://…` being treated as a download request.                |
| `downloader-engine/src/ytdlp/format-selector.test.ts`     | The `-f` fallback chain (resolution before codec), the video and audio menus, quality-string parsing. The most consequential logic in the engine.                                                                                                                          |
| `downloader-engine/src/ytdlp/args-builder.test.ts`        | Every argv list, one describe per builder.                                                                                                                                                                                                                                 |
| `downloader-engine/src/ytdlp/audio-availability.test.ts`  | `hasExtractableAudio` and the audio menu: no "🎵 only audio" button for a source that has no audio track.                                                                                                                                                                  |
| `downloader-engine/src/ytdlp/ytdlp-node-runner.test.ts`   | `dumpJson`: that inspection never touches FFmpeg (the runner is built with an FFmpeg path that does not exist), the `--` terminator before the URL, an argument array and never a shell, signal forwarding, and stderr reaching the mapper.                                |
| `downloader-engine/src/ytdlp/info-mapper.test.ts`         | Extractor document → `EngineMediaInfo`, plus `toIsoDate`.                                                                                                                                                                                                                  |
| `downloader-engine/src/ytdlp/stale-cookie-retry.test.ts`  | `withStaleCookieRetry`: retries once on a stale-session phrase, never otherwise.                                                                                                                                                                                           |
| `downloader-engine/src/errors/ytdlp-error-mapper.test.ts` | Message classification, retry disposition, "how the process ended outranks what it printed", output sanitisation, `matchesStaleSession`.                                                                                                                                   |
| `downloader-engine/src/media/playback-normalizer.test.ts` | `planNormalization` — which of the four delivery modes a probe leads to — and `parseFfprobeOutput`.                                                                                                                                                                        |

### Unit — `features/`

| File                                                             | Covers                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `downloader/src/domain/entities/job-status.test.ts`              | The state machine: the happy path, refusing to walk backwards or skip a step, failure/cancellation from every live status, nothing after a terminal status, same-status re-application as a no-op, and that `ACTIVE_STATUSES` contains exactly the six unfinished statuses.      |
| `downloader/src/presentation/telegram/callback-data.test.ts`     | Round-tripping, Telegram's 64-byte budget, and a table of eleven hostile/stale inputs that must decode to `undefined` rather than throw — another feature's prefix, `dl:../../etc`, an over-long token, the ambiguous characters `I`/`L`/`O`/`U` the short-id alphabet excludes. |
| `downloader/src/presentation/telegram/messages/fa.test.ts`       | A sentence for every failure code, a label for every stage and platform, no technical term ever leaking, the media card omitting absent fields and escaping HTML, the progress message coping with an unknown total.                                                             |
| `downloader/src/application/services/progress-throttler.test.ts` | When an update is worth spending a Telegram edit on.                                                                                                                                                                                                                             |
| `downloader/src/application/services/progress-writer.test.ts`    | `ProgressWriter`: normalising before the repository sees a value, one write in flight at a time with latest-wins, a failing write logged and never rethrown, backward movement dropped unless `beginPhase()` declared it, and nothing scheduled after `close()`.                 |

### Integration — `tests/integration/`

`engine-pipeline.test.ts` builds a real `EngineBundle` against a temporary
directory and a `ScriptedRunner` that implements `YtDlpRunner` without spawning
anything. It writes real files into the workspace, so everything above the process
boundary is exercised for real: the info mapper, the quality menu, the format
selector (including the Instagram-vs-TikTok progressive shortcut), progress and
stage callbacks, output discovery, the cleanup guarantee on both success and
failure, error mapping (`Video unavailable` → `MEDIA_NOT_FOUND`, the Instagram auth
wall → `LOGIN_REQUIRED`), and that the URL guard rejects `http://169.254.169.254/…`
before the runner is ever called.

`media-classification.test.ts` answers a narrower question with the same
machinery: given a document a real extractor produced, does the bot offer the
right buttons? Its `FixtureRunner` replays one of the `tests/fixtures/x-posts.ts`
documents instead of spawning anything, so the cases are the ones that are
awkward in practice — video and audio for an ordinary video tweet, **no** audio
for a tweeted GIF (which has no audio track), an image and never audio for a
single-photo tweet, the first item of a multi-photo tweet, the video from a tweet
that mixes a photo and a video, a typed unsupported-media error for a text-only
tweet, an empty menu for a text-only tweet (which is what the use case turns into
`UNSUPPORTED_MEDIA`), an image selection carried through to a real file via
`--write-thumbnail` rather than a video format selector, and the video and audio
ladders a YouTube document produces. The load-bearing one asserts that a
photo-only or text-only document yields **no** video and **no** audio option at
all: an option in the menu is a promise, and a button that could only fail when
tapped is worse than no button.

`workspace.test.ts` uses the real filesystem, because _"the workspace exists to
survive concurrent jobs, crashed workers and hostile filenames, and none of those
can be exercised against a mock"_: unique directories per job, an output template
built from `%(id)` and never `%(title)`, size accounting, surviving a directory that
has been deleted underneath it, idempotent cleanup, the orphan sweep (and that it
leaves unrelated directories alone), `ensureWritable`, the `INSUFFICIENT_STORAGE`
refusal, and the size watchdog aborting a download that outgrows its ceiling.

### E2E — `tests/e2e/`

#### `download-flow.test.ts`

The whole feature wired with in-memory adapters — _"Real use cases, real state
machine, real optimistic locking — only the process boundaries are faked."_ Five
groups:

- **the happy path** — link to delivered file, media title recorded, selected
  quality reaching the downloader, a second inspection served from cache with one
  extractor call, and an image-only pin offering a single image option.
- **idempotency and races** — a redelivered completed job must not download or send
  twice; only the first of two rapid taps queues; a tap from someone else in the
  chat is refused; an expired card is refused; a queue message whose row is gone is
  discarded.
- **limits and refusals** — the per-user active-job limit, the inspect rate limit, a
  file that downloads fine but is too large to send, a private post.
- **failure handling** — a permanent failure writes `failed` and does not retry; a
  transient one is rethrown and leaves the row in `downloading`; the workspace is
  cleaned up even when the upload fails.
- **cancellation** — cancelling a queued job removes it from the queue _and_
  broadcasts the intent; aborting the signal stops a running download; cancelling
  something already finished reports `'already-finished'` rather than an error.

#### `progress-resilience.test.ts`

One group, `progress persistence never endangers the download`, built around the
exact sample that took a worker down — `totalBytes: 1492973.3333333335`, which
yt-dlp produced by dividing a fragment count into an estimate without rounding.
It asserts that no fractional byte count ever reaches the repository, that the job
completes even when **every** progress write fails, that failing writes produce no
unhandled rejection (the thing the worker's shutdown handler treats as fatal),
that a burst of samples is coalesced into far fewer writes, that the final state
is persisted before the job is marked completed, and that the workspace is still
cleaned up on a failure path with progress writes also failing.

It belongs in e2e rather than next to `ProgressWriter` because the guarantee is
about the whole job surviving, not about the writer's own behaviour — which is
what `progress-writer.test.ts` covers.

### Smoke — `tests/smoke/extractors.test.ts`

See below.

---

## Running one file or one test

```bash
# One file (the pattern is matched against the path)
npx vitest run --project unit job-status
npx vitest run --project unit packages/config/src/load-config.test.ts

# One test or describe block by name
npx vitest run --project unit -t 'refuses to walk backwards'
npx vitest run --project e2e  -t 'idempotency and races'

# Watch a single file
npx vitest --project unit format-selector
```

`npm run test:watch` is `vitest --project unit` with no filter.

The `--project` flag is required for anything outside `unit`, because a bare path
under `tests/` matches no `unit` include pattern and Vitest reports "no test files
found".

---

## Why the smoke suite is opt-in

`tests/smoke/extractors.test.ts` is the only suite that touches the public
internet. It gates itself:

```ts
const ENABLED = process.env.RUN_SMOKE_TESTS === '1';
…
describe.skipIf(!ENABLED)('extractor smoke tests', () => {
```

and each platform gates itself again on its URL:

```ts
    it.skipIf(target.url === undefined)(
      `still extracts metadata from ${target.platform}`,
```

so an operator validating a yt-dlp bump can run it with a link for one platform
only.

`TARGETS` currently holds Instagram, TikTok, Pinterest and X. YouTube is not in
it: its extractor behaviour is covered deterministically by the `YOUTUBE_VIDEO`
fixture in `tests/integration/media-classification.test.ts`, and its URL handling
by `youtube.test.ts`. Add a `SMOKE_YOUTUBE_URL` target if you want live coverage
of the extractor itself — the gap is that no fixture can tell you the day YouTube
changes what it serves.

The reasoning, from the file header: extractors break when a site changes its
markup, which no fixture can predict — so this exists to answer "does yt-dlp still
understand these four platforms" after a version bump. _"It is NOT part of
`npm test`: it needs a real binary, real network access and real URLs, and any of
those being unavailable would turn an ordinary CI run red for reasons unrelated to
the change under review."_

The workflow, `.github/workflows/smoke.yml`, is `workflow_dispatch` only, with the
same argument stated more bluntly:

> Manual only. This is the one suite that touches the public internet, and it fails
> for reasons unrelated to any change under review — a site redesign, a rate limit,
> a link that has since been deleted. Running it per-push would train everyone to
> ignore a red build.

It takes an optional `ytdlp_version` input (defaulting to whatever
`Dockerfile.worker` pins), installs that exact release, and reads the four post URLs
from `SMOKE_*_URL` secrets in the `smoke` GitHub environment — kept as secrets _"so
the job's logs and this file do not become a list of links to hammer"_.

Locally:

```bash
RUN_SMOKE_TESTS=1 \
  SMOKE_INSTAGRAM_URL='https://www.instagram.com/reel/…' \
  YTDLP_PATH=/usr/local/bin/yt-dlp \
  npm run test:smoke
```

The load-bearing assertion is `expect(options.length).toBeGreaterThan(0)` — _"an
empty menu means the extractor changed and the bot would show a card with no
buttons."_

---

## ESLint on test files

`eslint.config.js` turns type-aware linting off for tests, and explains why in a
comment rather than leaving it as a mystery:

```js
  {
    // Tests sit next to the sources they cover but are excluded from each
    // package's tsconfig, so the type-aware parser has no program for them.
    // Turning type checking off here is the honest fix: the alternative is a
    // second tsconfig per package that exists only to satisfy the linter.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
```

The exclusion it refers to is in every package's `tsconfig.json`:

```json
  "exclude": ["src/**/*.test.ts", "dist", "node_modules"]
```

Tests are excluded from the build so they never ship in `dist/`. `typescript-eslint`'s
`projectService` therefore cannot find a program that contains them, and the
type-aware rules would error out on every file. The alternative — a second tsconfig
per package that exists only for the linter — was rejected as more machinery than
the problem is worth.

Tests are still type-checked, just not by ESLint: `tests/tsconfig.json` covers
`tests/**/*.ts` under `npm run check-types`. Note that per-package `*.test.ts` files
next to their sources are checked by neither, so a type error in a unit test
surfaces when Vitest runs it, not before.

Practical consequence: `!` non-null assertions and `process.env` are fine in tests.
`tests/smoke/extractors.test.ts` reads `process.env.RUN_SMOKE_TESTS` directly for
exactly this reason.

---

## What to test when you add code

Follow what is already there.

**Pure decision logic → unit test, next to the source.** If a function has no
filesystem, no process, no clock and no network, it gets a unit test with a table of
cases. This is where most of the value is, and the codebase leans on it: the format
selector, the state machine, the error pattern list, the callback codec, the URL
guard, the config loader. `YtDlpFormatSelector` is explicitly _"deliberately pure —
no filesystem, no process, no clock — so every rule below is covered by a unit
test."_

Anything security-relevant belongs here too, with the hostile inputs enumerated:
`url-guard.test.ts` has a `describe('UrlGuard — SSRF surface')` block, and
`callback-data.test.ts` has an `it.each` table of eleven malformed callbacks.

**Adapters → integration test under `tests/integration/`.** An adapter's job is to
talk to something real, so test it against the real thing where that is cheap (the
filesystem, in `workspace.test.ts`) and against a scripted port where it is not (the
process boundary, in `engine-pipeline.test.ts`'s `ScriptedRunner`). The line is
drawn at "would this need a running server": Postgres and Redis adapters have no
integration test, and their behaviour is covered indirectly through the in-memory
repositories that reimplement their contract.

**Whole flows → e2e test under `tests/e2e/`.** One `createHarness()` function wiring
real use cases to in-memory adapters, then a test per outcome. Reach for this when
the behaviour spans use cases — a race, an idempotency guarantee, a cleanup that has
to happen on a failure path.

**Extractor reality → the smoke suite, and only there.** Never let a live network
call into `unit`, `integration` or `e2e`.

Two habits worth copying:

- Every test name states the behaviour, not the method: _"refuses to walk
  backwards"_, _"lets only the first of two rapid taps queue a download"_, _"reports
  only what is certain when the total is unknown"_.
- Where a test encodes a decision that cost someone an afternoon, the comment says
  what the failure looked like — see the `yt-dlp SKIPS an output whose file already
exists` comment in `workspace.test.ts`, or the regression guard in
  `load-config.test.ts` about the default job timeout.

Before pushing:

```bash
npm run lint
npm run check-types
npm test
npm run test:e2e
npm run test:integration
npm run build
```

which is exactly what the `verify` job in CI does.
