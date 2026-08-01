# Security notes

This bot takes a URL from an unauthenticated stranger and hands it to a program
that makes network requests and writes files. That is the whole threat model in
one sentence. Everything below follows from it.

---

## 1. Server-Side Request Forgery

**The risk.** A user sends `http://169.254.169.254/latest/meta-data/` and the
bot fetches it from inside your VPC. On most cloud providers that endpoint hands
out instance credentials to anything that can make an HTTP request.

**What we do.** Every user-supplied URL passes through
[`UrlGuard`](../packages/downloader-engine/src/security/url-guard.ts) before it
reaches yt-dlp, `fetch`, or the database. The checks run cheapest-and-most-
decisive first, so a hostile input is rejected before anything touches the
network:

| #   | Check                                         | Rejects                                                           |
| --- | --------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Length ≤ 2048                                 | payload-stuffed URLs                                              |
| 2   | `new URL()` parses                            | malformed input                                                   |
| 3   | Protocol is `http:`/`https:`                  | `file:`, `ftp:`, `javascript:`, `data:`                           |
| 4   | No embedded credentials                       | `https://instagram.com@evil.test/` — parses with host `evil.test` |
| 5   | Host is not an IP literal                     | the entire bare-address class, including `[::1]`                  |
| 6   | Host is not `localhost`/`*.local`             | loopback by name                                                  |
| 7   | No explicit port                              | `https://instagram.com:8080/…`                                    |
| 8   | Host matches an **anchored** platform pattern | `instagram.com.evil.test`, `notinstagram.com`                     |
| 9   | Path looks like a single post                 | profile and feed URLs                                             |

Step 8 is the one that is easy to get wrong. Patterns are built by
[`defineHostPatterns`](../packages/downloader-engine/src/platforms/platform-definition.ts),
which anchors both ends:

```ts
export function defineHostPatterns(hosts: readonly string[]): readonly RegExp[] {
  return hosts.map((host) => new RegExp(`^${host}$`, 'i'));
}
```

An unanchored `hostname.includes('instagram.com')` accepts
`instagram.com.attacker.test` — that single mistake is the most common way a URL
allow-list becomes an SSRF hole. `packages/downloader-engine/src/security/url-guard.test.ts`
asserts every look-alike shape is refused.

**Address rules.** [`ip-rules.ts`](../packages/downloader-engine/src/security/ip-rules.ts)
blocks loopback, all RFC 1918 ranges, carrier-grade NAT, link-local (including
the metadata endpoint), multicast, reserved space, and their IPv6 equivalents —
plus the three ways an IPv4 destination can hide inside an IPv6 address:
`::ffff:` mapping, `64:ff9b::/96` NAT64, and `2002::/16` 6to4. Anything it cannot
parse is **refused**, not allowed: a guard that fails open is not a guard.

> **A bug worth remembering.** The first version of the mask comparison used
> JavaScript's bitwise operators without normalising the result. `&` returns a
> _signed_ 32-bit integer, so `0xac100000 & 0xfff00000` (172.16/12) evaluated
> negative while the runtime side produced an unsigned value, and the two never
> matched. Every range whose first octet has the high bit set — 172.16/12,
> 192.168/16, **169.254/16**, 198.18/15, 224/4, 240/4 — silently passed. The
> unit test caught it; the fix is the `>>> 0` on both the mask and the base.

**Short links.** `vm.tiktok.com`, `pin.it` and `t.co` carry no media, so they
have to be resolved. [`RedirectResolver`](../packages/downloader-engine/src/security/redirect-resolver.ts)
follows them one hop at a time with `redirect: 'manual'` — never by letting
`fetch` chase them — and revalidates each `Location` through the same guard.
Combined with the allow-list, this gives a strong property: **the bot only ever
opens a connection to a host in the platform registry.** Hops are capped at
five, each with an 8-second budget, and every host is DNS-resolved and checked
against the address rules first as a defence against rebinding.

---

## 2. Command injection

No shell is ever involved.

- yt-dlp is spawned through `ytdlp-nodejs`'s builders, which use `shell: false`.
- FFmpeg and ffprobe go through
  [`runProcess`](../packages/downloader-engine/src/process/run-process.ts), which
  uses `execFile` — never `exec`, which hands its string to `/bin/sh`.
- Arguments are built as **arrays** by
  [`args-builder.ts`](../packages/downloader-engine/src/ytdlp/args-builder.ts).
  No template literal ever produces a command line.

Every yt-dlp invocation also carries `--ignore-config`. Without it, a
`yt-dlp.conf` anywhere on the search path can silently change format selection,
the output path, or the post-processing of a production download.

---

## 3. Path traversal and hostile filenames

A media title is a string a stranger wrote. It reaches the filesystem and
Telegram's `filename` field.

- The `-o` template uses **`%(id).100s.%(ext)s`, never `%(title)s`.** The
  extractor id is short and constrained; a title can be 400 characters of
  bidirectional-override marks, or `../../etc/passwd`.
- [`sanitizeFilename`](../packages/shared/src/fs/sanitize-filename.ts) reduces
  any string to one safe segment: separators stripped, control characters and
  bidi/zero-width marks removed by code point, Windows device names replaced,
  leading/trailing dots removed, and a UTF-8 **byte** cap that truncates on a
  character boundary.
- Before any produced file is used or deleted,
  [`assertContainedPath`](../packages/shared/src/fs/path-safety.ts) resolves
  symlinks and confirms the real path is inside the job workspace. A
  post-processor could otherwise leave a link pointing out of the tree, and
  `rm -r` would follow it.

---

## 4. Resource exhaustion

| Limit         | Mechanism                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Download size | Two tiers: yt-dlp's `--max-filesize` (fires only when the extractor declared a size) **and** a runtime watchdog polling the workspace every 3 s |
| Upload size   | Checked before the upload starts, so an undeliverable file fails fast                                                                           |
| Disk          | `MIN_FREE_DISK_MB` refuses a job rather than filling the volume                                                                                 |
| CPU           | `MAX_TRANSCODE_MB` — above it, an incompatible codec is remuxed instead of re-encoded                                                           |
| Time          | Independent budgets for inspect, download, ffmpeg, upload, and the whole job                                                                    |
| Concurrency   | `MAX_ACTIVE_JOBS_PER_USER` — one user cannot occupy every worker slot                                                                           |
| Rate          | Fixed-window counters per user, in Redis so the limit holds across replicas                                                                     |

The runtime watchdog is the important half. `--max-filesize` does nothing when
the extractor declares no size, which is the normal case for Instagram, TikTok
and every HLS stream — without the watchdog, one link can still fill the disk,
and losing the disk takes the container runtime with it.

---

## 5. Secrets

**Never logged.** The Pino instance redacts a list of paths
([`redaction.ts`](../packages/logger/src/redaction.ts)) _and_ scrubs free text
for anything shaped like a bot token or a URL with embedded credentials —
because `redact` only walks object paths, and a token in a stringified error
would slip past it.

**Never stored.** Cookies do not travel through the queue, the database, or a
job payload. They are read at the moment of use by
[`FileCookieProvider`](../packages/downloader-engine/src/cookies/file-cookie-provider.ts)
from a file the operator mounts, written to a `0600` temp file for the duration
of one call, and deleted in a `finally`.

**Never echoed.** yt-dlp prints full request URLs — cookies included — to
stderr. The error mapper keeps only the last few `ERROR:` lines and clips them
to 400 characters, and `truncateForStorage` bounds anything that reaches the
database.

### On using cookies at all

Supplying a `cookies.txt` makes the bot act as that account.

- Use only an account **you** control and are permitted to automate.
- Prefer a dedicated account over a personal one. If the session leaks, you
  revoke an account you do not care about.
- Mount the file read-only, outside the image (`./secrets:/run/secrets:ro`).
  Never bake it into a layer — layers are shipped and cached.
- A leaked cookie file is a full account takeover. Treat it as a password.
- Rotate it when the log says
  `authenticated attempt failed in a way that suggests an expired session`.

The bot works without any cookies. That is the default, and it is the
configuration to prefer.

---

## 6. Privacy

A media URL can carry a signed CDN token, a per-share identifier, or a tracking
parameter. A database backup outlives the reason it was taken.

- `STORE_FULL_SOURCE_URL` defaults to **false**: only the query-free form is
  persisted.
- The indexed lookup key is a **SHA-256 hash** of the normalised URL, not the
  URL.
- `redactUrl` replaces a query string with a parameter _count_ before anything
  is logged.
- `download_events.payload` accepts only clipped scalars — objects and arrays
  are dropped rather than flattened.

Operators should still tell their users what is retained. `download_jobs` holds
a Telegram user id, a chat id, and a URL for as long as the row exists; there is
no automatic retention cut-off in this phase.

---

## 7. Multi-user safety

The bot is used in group chats, where a card is visible to everyone.

- Every callback checks **ownership** before acting. Without it, anyone could
  spend another person's quota by tapping their buttons.
- "Not found" and "not yours" return the same answer, so a stranger cannot probe
  for the existence of another user's job.
- `callback_data` carries only a short opaque job handle and an option id — no
  URL, no user id, nothing a crafted callback could use to describe a download
  of its own. Anything unrecognised is ignored rather than treated as an error.
- Callbacks expire (`DOWNLOAD_SELECTION_TTL_SECONDS`), and a replayed one finds
  a job whose status has already moved past `awaiting_selection`.

---

## 8. Container posture

- Both images run as a **non-root** user (uid 1001).
- `tini` is PID 1, so SIGTERM reaches Node and a killed yt-dlp child is reaped
  instead of becoming a zombie.
- The **bot image has no writable media volume.** It cannot download even if a
  bug tried to — that is a property of the deployment, not a rule someone has to
  remember.
- Only the health ports are published, and only on `127.0.0.1`. Postgres and
  Redis are reachable on the internal bridge network alone.
- `.dockerignore` excludes `.env`, `secrets/` and every `*cookies*.txt`.

---

## Reporting

Found something? Open a private security advisory on the repository rather than
a public issue.
