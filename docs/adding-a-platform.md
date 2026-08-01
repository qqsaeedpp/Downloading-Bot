# Adding a platform to the downloader

Five platforms ship today: Instagram, TikTok, Pinterest, X/Twitter and YouTube.
Adding a sixth — Reddit, say — is mostly declarative, but the slug still appears
in several places that are not all guarded by the same test. This is the full
list.

YouTube was the last one added, so its files are the most useful worked example
in the repository — including the migration and the one capability the first four
did not need, `canonicalize`.

Read first:

- `packages/downloader-engine/src/platforms/platform-definition.ts` — the interfaces.
- `packages/downloader-engine/src/platforms/instagram.ts` — the simplest definition.
- `packages/downloader-engine/src/platforms/pinterest.ts` — the one with the awkward host list.
- `packages/downloader-engine/src/platforms/youtube.ts` — the one that canonicalises.
- `packages/downloader-engine/src/platforms/registry.ts` — how definitions are found.

---

## 1. The two interfaces

`PlatformDefinition` is what the registry holds:

```ts
export interface PlatformDefinition {
  readonly platform: MediaPlatform;
  readonly hostPatterns: readonly RegExp[];
  supports(url: URL): boolean;
  createPolicy(): PlatformDownloadPolicy;
  canonicalize?(url: URL): URL;
}
```

`hostPatterns` answers "is this host ours at all" (used by the SSRF guard's error
message and by `registry.isKnownHost`). `supports()` answers the stricter question
"does this URL point at a single downloadable post" — a bare profile link matches
the host but must not match `supports`, so the user gets a precise "unsupported
link" instead of a confusing extractor failure. `canonicalize` is optional and
described at the end of this section.

`PlatformDownloadPolicy` is the data description the rest of the engine branches on
instead of writing `switch (platform)` in four different files.

### `preferProgressive: boolean`

Consumed in `YtDlpMediaEngine.#buildVideoSelector`:

```ts
    allowProgressiveShortcut: policy.preferProgressive && requestedHeight === undefined,
```

and in `YtDlpFormatSelector.buildVideoSelector`, where it prepends two
unconstrained candidates to the head of the `/`-separated fallback chain:

```ts
if (input.allowProgressiveShortcut) {
  chain.push(`b${lenient}[vcodec^=avc1]`, `b${lenient}`);
}
```

**Consequence:** the platform's unlabelled pre-muxed file is tried before any
labelled rendition. Instagram publishes every reel twice — as VP9 DASH renditions
yt-dlp can describe, and as the same picture in a progressive MP4 whose codec and
height it cannot read. Any `[height=…]` filter therefore lands on the VP9 copy,
which then costs a full re-encode to become playable on a phone. This flag skips
that. It is deliberately suppressed when the user asked for a specific height,
because the pre-muxed file carries no height metadata and honouring "480p" with it
would silently hand back something else.

Set it `true` only if you have actually measured that the platform's `best`
pre-muxed stream is H.264/AAC. TikTok sets it `false` with the comment "TikTok's
labelled formats are the good ones, and its progressive file is already H.264 — no
shortcut needed".

### `imageFirst: boolean`

Consumed in `YtDlpMediaEngine.listQualityOptions`:

```ts
if (info.mediaKind === MediaKind.Image || (policy.imageFirst && info.formats.length === 0)) {
  return [/* a single DownloadType.Image option */];
}
```

**Consequence:** when the extractor reported no formats at all, the platform is
still offered as a still image rather than falling through to an empty or
"best-effort video" keyboard. Pinterest sets it `true`; the overwhelming majority
of pins are stills.

### `supportsAudioExtraction: boolean`

**Consequence:** when `false`, `listQualityOptions` never calls
`listAudioOptions`, so no "🎵 only audio" buttons appear. Pinterest is `false`.

### `retryWithoutCookies: boolean`

Consumed by `withStaleCookieRetry`, in both `inspect` and `download`:

```ts
if (cookies === undefined || !allowRetry) return run(cookies);
try {
  return await run(cookies);
} catch (error: unknown) {
  const message = describeError(error);
  if (!matchesStaleSession(message)) throw error;
  logger.warn(
    'authenticated attempt failed in a way that suggests an expired session; retrying anonymously — refresh this platform cookie file',
    { platform },
  );
  return run(undefined);
}
```

**Consequence:** an authenticated attempt that fails with one of
`STALE_SESSION_PATTERNS` is retried exactly once, anonymously. This is worth having
because a _stale_ session is worse than no session: Instagram answers an
invalidated `sessionid` with a flat 404 on a reel that resolves fine
unauthenticated. Set it `true` where a dead session produces a distinctive failure
(Instagram, X). Set it `false` where it does not — TikTok's comment says as much,
and retrying every error would double the load on an extractor that already said no.

Note the guard: it does nothing at all when no cookies are configured for the
platform.

### `shortLinkHosts: readonly string[]`

Consumed in two places. `UrlGuard.parse` sets `isShortLink` from it:

```ts
      isShortLink: policy.shortLinkHosts.includes(hostname),
```

and `RedirectResolver.resolve` returns immediately unless that flag is set:

```ts
if (!start.isShortLink) return start;
```

**Consequence:** only hosts on this list get a `HEAD` request with
`redirect: 'manual'`, up to five hops, each hop re-validated by the same
`UrlGuard`. Everything else goes straight to yt-dlp with no network round trip.
Entries must be **plain lowercase hostnames**, not regexes — `includes` is an exact
string comparison. The host must also be matched by `hostPatterns`, or the guard
rejects it before `isShortLink` is ever read.

### `extraArgs: readonly string[]`

Appended verbatim by `buildBaseArgs`:

```ts
if (input.cookiePath !== undefined) args.push('--cookies', input.cookiePath);
args.push(...input.platformExtraArgs);
```

**Consequence:** every yt-dlp invocation for the platform — inspect, video, audio,
image — carries these. One array element per argv token; the runner spawns without
a shell, so `'--extractor-args'` and its value are two separate strings. All five
current platforms use `[]`.

### `strippableQueryParams: readonly string[]`

Consumed by `normalizeUrl(url, policy.strippableQueryParams)` inside `UrlGuard.parse`.

**Consequence:** these parameters are deleted from the canonical URL, which is what
gets hashed into `normalizedUrlHash` — the cache key and the job's identity. Get
this wrong and the same post produces a different cache entry for every person who
shares it. Instagram's comment is the clearest statement of the failure mode:
`igsh`/`igshid` are per-share identifiers, so "one cache entry" becomes "thousands".

Always spread `COMMON_TRACKING_PARAMS` first, then add the platform's own:

```ts
strippableQueryParams: [...COMMON_TRACKING_PARAMS, 'igshid', 'igsh', 'img_index'],
```

### `canonicalize?(url: URL): URL` — optional

Most platforms have exactly one URL shape per post, and for those the hook should
simply be left off. Implement it when the same post is reachable by several
genuinely different URLs, because without it each shape is its own cache miss and
its own extractor call.

YouTube is the case that forced it into the interface. One video arrives as
`youtu.be/<id>`, `/watch?v=<id>&t=90`, `/shorts/<id>`, `/embed/<id>`, `/live/<id>`,
`music.youtube.com/watch?v=<id>` and `m.youtube.com/…`. Its `canonicalize` extracts
the id and rebuilds a single form:

```ts
  canonicalize(url: URL): URL {
    const videoId = extractYouTubeVideoId(url);
    if (videoId === undefined) return url;
    const canonical = new URL('https://www.youtube.com/watch');
    canonical.searchParams.set('v', videoId);
    return canonical;
  },
```

Two things follow from rebuilding rather than editing. The first is caching: the
canonical URL is what `normalizeUrl` hashes into `normalizedUrlHash`. The second
is the playlist safeguard — a URL built from the id alone cannot carry `list` or
`index`, so yt-dlp is handed exactly the video the user pointed at and cannot
wander into item one of two hundred. That is why the app never downloads a
playlist, and it is a property of this function rather than a flag someone has to
remember to pass.

`UrlGuard.parse` calls the hook **after** the host and path checks, never before,
because it rebuilds a URL and validating a different string from the one that
reaches the extractor is how allow-lists get bypassed. The result becomes both the
cache key and `SafeMediaUrl.requestUrl` — see §1 of
[`security.md`](./security.md) for the three URL fields the guard returns.

**Returning the URL unchanged is always valid**, and is the right answer whenever
the id cannot be extracted: YouTube does exactly that for a URL its own
`extractYouTubeVideoId` does not recognise, rather than inventing a shape.

---

## 2. Write the definition

`packages/downloader-engine/src/platforms/reddit.ts`:

```ts
import { MediaPlatform } from '@tgtools/shared';
import type { PlatformDefinition, PlatformDownloadPolicy } from './platform-definition.js';
import {
  COMMON_TRACKING_PARAMS,
  defineHostPatterns,
  matchesAnyPattern,
} from './platform-definition.js';

const HOST_PATTERNS = defineHostPatterns([
  String.raw`(?:www\.|old\.|new\.|m\.)?reddit\.com`,
  String.raw`redd\.it`,
]);

export const REDDIT_SHORT_HOSTS: readonly string[] = ['redd.it'];

const MEDIA_PATH = /^\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+/;

export const redditPlatform: PlatformDefinition = {
  platform: MediaPlatform.Reddit,
  hostPatterns: HOST_PATTERNS,

  supports(url: URL): boolean {
    if (!matchesAnyPattern(url.hostname, HOST_PATTERNS)) return false;
    if (REDDIT_SHORT_HOSTS.includes(url.hostname.toLowerCase())) return url.pathname.length > 1;
    return MEDIA_PATH.test(url.pathname);
  },

  createPolicy(): PlatformDownloadPolicy {
    return {
      platform: MediaPlatform.Reddit,
      preferProgressive: false,
      imageFirst: false,
      supportsAudioExtraction: true,
      retryWithoutCookies: false,
      shortLinkHosts: REDDIT_SHORT_HOSTS,
      extraArgs: [],
      strippableQueryParams: [...COMMON_TRACKING_PARAMS],
    };
  },
};
```

### Anchoring, and why it is an SSRF control

Never build `hostPatterns` by hand. `defineHostPatterns` anchors both ends:

```ts
export function defineHostPatterns(hosts: readonly string[]): readonly RegExp[] {
  return hosts.map((host) => new RegExp(`^${host}$`, 'i'));
}
```

Its own comment states the reason: _"so that `instagram.com.evil.test` cannot pass
for Instagram — an unanchored `includes('instagram.com')` is the single most common
way a URL allow-list turns into an SSRF hole."_

The threat is concrete. The host allow-list is the thing that decides whether a
user-supplied URL is handed to yt-dlp and to `fetch`. An unanchored or wildcarded
pattern lets an attacker register `reddit.com.attacker.test`, or point
`sub.reddit.com.attacker.test` at `169.254.169.254`, and get the worker to fetch it
from inside your network. Pinterest's file spells out the same rule for suffix
wildcards — it enumerates twenty-four country domains rather than writing
`pinterest\..+`, because that pattern "would happily accept
`pinterest.attacker.test`".

Two more details that the shared helpers already handle, so do not reimplement them:

- `matchesAnyPattern` strips a trailing dot and lowercases before testing, because
  `reddit.com.` is a distinct fully-qualified name that resolves identically.
- `UrlGuard.parse` independently rejects non-http(s) schemes, embedded credentials
  (`https://reddit.com@evil.test/`), bare IP literals, `localhost`/`.local`, and
  explicit ports — before your `supports()` is called.

Cover the hostile cases with tests in
`packages/downloader-engine/src/security/url-guard.test.ts`, which already has
`describe('UrlGuard — host confusion')` and `describe('UrlGuard — SSRF surface')`
blocks to extend.

---

## 3. Add the slug to the vocabulary

`packages/shared/src/media/vocabulary.ts`, in **two** places — the tuple first,
then the object:

```ts
export const MEDIA_PLATFORM_VALUES = [
  'instagram',
  'tiktok',
  'pinterest',
  'x',
  'youtube',
  'reddit',
] as const;

export const MediaPlatform = {
  Instagram: 'instagram',
  TikTok: 'tiktok',
  Pinterest: 'pinterest',
  X: 'x',
  YouTube: 'youtube',
  Reddit: 'reddit',
} as const;
```

`MEDIA_PLATFORM_VALUES` is the single source of truth, and it is a non-empty tuple
for one reason: a Zod schema can be built straight from it with
`z.enum(MEDIA_PLATFORM_VALUES)` instead of repeating the literals. `DOWNLOAD_TYPE_VALUES`
and `MEDIA_KIND_VALUES` exist for the same reason. `ALL_MEDIA_PLATFORMS` derives
from the tuple, so nothing else in that file changes.

## 4. Add it to the Postgres enum

`packages/database/src/schema/enums.ts`:

```ts
export const platformEnum = pgEnum('media_platform', [
  'instagram',
  'tiktok',
  'pinterest',
  'x',
  'youtube',
  'reddit',
]);
```

These two must not drift. `packages/database/src/schema/vocabulary.test.ts` fails
if they do:

```ts
describe('media_platform enum', () => {
  it('holds exactly the platforms the shared vocabulary defines', () => {
    expect(sorted(platformEnum.enumValues)).toEqual(sorted(ALL_MEDIA_PLATFORMS));
  });
```

(The file's header comment calls it `schema-vocabulary.test.ts`; the file on disk is
`vocabulary.test.ts`.)

## 5. Generate a migration

```bash
npm run db:generate
```

which runs `drizzle-kit generate --config=packages/database/drizzle.config.ts` and
writes into `infra/migrations/`. Review the emitted SQL — it should be a single
`ALTER TYPE "public"."media_platform" ADD VALUE 'reddit';` — and commit both the
`.sql` file and the updated `infra/migrations/meta/` snapshot and journal.

`infra/migrations/0001_add_youtube_platform.sql` is the worked example, and it
shows the one edit worth making by hand:

```sql
ALTER TYPE "public"."media_platform" ADD VALUE IF NOT EXISTS 'youtube';
```

`IF NOT EXISTS` so that a hand-run against a database that already has the value
is a no-op rather than an error. Drizzle's journal already prevents a second
automated run; this covers the manual case. PostgreSQL 12+ permits
`ALTER TYPE … ADD VALUE` inside a transaction — which is how the migrator runs it —
provided the new value is not _used_ in the same transaction, and nothing in that
file does.

CI enforces this. The `migrations` job in `.github/workflows/ci.yml` applies the
migrations twice (proving idempotency) and then re-runs `db:generate`, failing on a
dirty tree:

```yaml
- name: Schema must match the Drizzle definitions
  run: |
    npm run db:generate
    if [ -n "$(git status --porcelain infra/migrations)" ]; then
      echo "::error::Schema drift: the Drizzle schema does not match infra/migrations."
```

## 6. The two Zod enums — nothing to do

There is no step here any more, but it is worth knowing why, because the two
schemas below used to be the easiest thing in this list to forget.

`downloadJobPayloadSchema` in
`features/downloader/src/infrastructure/queue/bullmq-download-queue.ts` and
`cachedMediaInfoSchema` in
`features/downloader/src/infrastructure/cache/redis-media-inspection-cache.ts`
both used to repeat `z.enum(['instagram', 'tiktok', 'pinterest', 'x'])` by hand.
Neither was covered by the vocabulary drift test, so a new slug in §3 with no
matching edit here produced two silent failures: a queue payload that failed
validation was logged and **discarded** by the processor
(`'discarding an unparsable job payload'`) — a job that vanished with no
user-visible error — and a cache entry that failed validation degraded every
inspection into a fresh yt-dlp run.

Both now build from the shared vocabulary:

```ts
    platform: z.enum(MEDIA_PLATFORM_VALUES),
    type: z.enum(DOWNLOAD_TYPE_VALUES),
```

and the cache schema additionally uses `z.enum(MEDIA_KIND_VALUES)`, all imported
from `@tgtools/shared`. Adding a slug in §3 reaches them with no further edit. If
you write a third schema that needs the platform set, derive it the same way
rather than typing the literals out.

## 7. The Persian label

`features/downloader/src/presentation/telegram/messages/fa.ts`:

```ts
export const PLATFORM_LABELS_FA: Readonly<Record<MediaPlatform, string>> = {
  instagram: 'اینستاگرام',
  tiktok: 'تیک‌تاک',
  pinterest: 'پینترست',
  x: 'ایکس (توییتر)',
  youtube: 'یوتیوب',
  reddit: 'ردیت',
};
```

The `Record<MediaPlatform, string>` annotation is what makes a missing key a
compile error rather than an `undefined` in a user's message; `renderMediaCard`
indexes it with `PLATFORM_LABELS_FA[info.platform]`. The runtime assertion in
`fa.test.ts` no longer lists the keys by hand, so there is nothing to update
there:

```ts
it('has a label for every supported platform', () => {
  // Derived from the vocabulary rather than hard-coded, so adding a platform
  // fails here instead of rendering its raw slug to a Persian-speaking user.
  expect(Object.keys(PLATFORM_LABELS_FA).sort()).toEqual([...ALL_MEDIA_PLATFORMS].sort());
```

The prose is the part that is still manual. Three pieces of it enumerate the
supported platforms and must be updated by hand, because nothing checks them:

- `fa.noUrlFound` and `fa.failure(DownloadFailureCode.UnsupportedPlatform)` in `fa.ts`.
- `START_MESSAGE` in `features/start/src/index.ts`.

## 8. Register the definition

`packages/downloader-engine/src/platforms/registry.ts`:

```ts
export const DEFAULT_PLATFORM_DEFINITIONS: readonly PlatformDefinition[] = [
  instagramPlatform,
  tiktokPlatform,
  pinterestPlatform,
  xPlatform,
  youtubePlatform,
  redditPlatform,
];
```

and export it from `packages/downloader-engine/src/index.ts` alongside the other
five. Export any helper the definition needs to share too — YouTube exports
`extractYouTubeVideoId` next to `youtubePlatform`, because the id extraction is
the part a test wants to drive directly.

`createPlatformRegistry` calls `assertCompleteCoverage`, which throws
`EngineError(Internal, 'Platform registry is missing definitions for: …')` if a
slug in `ALL_MEDIA_PLATFORMS` has no definition. That check runs at engine
construction, i.e. inside `createBotContainer` and `createWorkerContainer` — so
step 3 without step 8 is a hard startup failure in **both** processes, not a
runtime surprise. Doing it in the other order is safe.

Detection order matters only for ambiguity: `detect()` returns the first definition
whose `supports()` returns true. Keep host sets disjoint and the order is
irrelevant.

## 9. Optional: cookie wiring

Only if the platform needs an authenticated session. Four edits:

1. `packages/config/src/env.schema.ts` — add `REDDIT_COOKIES_PATH: optionalText(),`
   next to the other five.
2. `packages/config/src/load-config.ts` — add the entry to `buildCookieConfig`:
   ```ts
   const entries: [MediaPlatform, string | undefined][] = [
     [MediaPlatform.Instagram, env.INSTAGRAM_COOKIES_PATH],
     // …
     [MediaPlatform.Reddit, env.REDDIT_COOKIES_PATH],
   ];
   ```
   `optionalText()` maps an empty or whitespace-only value to `undefined`, and
   `buildCookieConfig` omits undefined entries, so an unset variable means "run
   anonymously".
3. `.env.example` — add it under `── Cookies (optional) ──`.
4. `docker-compose.yml` — add it to the `x-app-env` anchor:
   ```yaml
   REDDIT_COOKIES_PATH: ${REDDIT_COOKIES_PATH:-}
   ```

Nothing else changes: `createDownloaderEngine` passes `config.cookies` straight
through, and `FileCookieProvider` keys off the platform. The provider degrades to
anonymous access on a missing, empty or non-Netscape file rather than failing the
job — see `looksLikeNetscapeCookieJar`.

`packages/config/src/load-config.test.ts` has a `describe('cookie paths')` block
that asserts the exact shape of `config.cookies`; extend it.

---

## Checklist

- [ ] `packages/downloader-engine/src/platforms/<name>.ts` with `hostPatterns` built by `defineHostPatterns` (anchored) and a `supports()` that rejects non-post paths.
- [ ] Short-link hosts listed as plain lowercase hostnames **and** matched by `hostPatterns`.
- [ ] `strippableQueryParams` spreads `COMMON_TRACKING_PARAMS` and adds the platform's per-share identifiers.
- [ ] `preferProgressive` set only after measuring the platform's pre-muxed stream.
- [ ] `canonicalize` implemented if one post has several URL shapes — or omitted, which is the common case.
- [ ] Slug added to `MEDIA_PLATFORM_VALUES` **and** `MediaPlatform` in `packages/shared/src/media/vocabulary.ts`.
- [ ] Slug added to `platformEnum` in `packages/database/src/schema/enums.ts`.
- [ ] `npm run db:generate`; the new `infra/migrations/*.sql` and `meta/` files committed, with `IF NOT EXISTS` added to the `ADD VALUE`.
- [ ] Persian label added to `PLATFORM_LABELS_FA` (the `fa.test.ts` assertion derives itself from the vocabulary).
- [ ] Prose in `fa.noUrlFound`, `fa.failure(UnsupportedPlatform)` and `features/start/src/index.ts` updated.
- [ ] Definition added to `DEFAULT_PLATFORM_DEFINITIONS` and exported from the engine's `index.ts`.
- [ ] Cookie env var wired through `env.schema.ts`, `load-config.ts`, `.env.example` and `docker-compose.yml`, if needed.
- [ ] Accepted and hostile URLs covered — in `packages/downloader-engine/src/security/url-guard.test.ts`, or a dedicated file next to the definition as `platforms/youtube.test.ts` does.
- [ ] `npm run lint && npm run check-types && npm test && npm run test:integration && npm run build`.

## The smoke test

Unit and integration tests never touch the network — `tests/integration/engine-pipeline.test.ts`
drives a `ScriptedRunner` that writes fake files. So nothing in `npm test` proves
that yt-dlp actually understands the new platform.

That is what `tests/smoke/extractors.test.ts` is for. It builds a real engine, calls
`urlGuard.parse` → `redirectResolver.resolve` → `engine.inspect` →
`listQualityOptions` against live URLs, and asserts a non-empty quality menu —
because _"an empty menu means the extractor changed and the bot would show a card
with no buttons"_.

Add your platform to its `TARGETS` array:

```ts
const TARGETS = [
  { platform: MediaPlatform.Instagram, url: process.env.SMOKE_INSTAGRAM_URL },
  // …
  { platform: MediaPlatform.Reddit, url: process.env.SMOKE_REDDIT_URL },
] as const;
```

Each target is `it.skipIf(target.url === undefined)`, so it self-skips without the
env var. Run it locally with a real public post:

```bash
RUN_SMOKE_TESTS=1 SMOKE_REDDIT_URL='https://www.reddit.com/r/…' npm run test:smoke
```

Then add `SMOKE_REDDIT_URL` to the `smoke` GitHub environment secrets and to the
`env:` block of `.github/workflows/smoke.yml`. That workflow is
`workflow_dispatch`-only on purpose; see `docs/testing.md`.
