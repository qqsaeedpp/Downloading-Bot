# Adding a bot feature

This walks through adding a new user-facing tool to the bot — say a "text tools"
or "file converter" feature. The repo is a modular monolith: a feature is an npm
workspace under `features/`, and the bot process only ever sees the one interface
it exports.

Existing features to read before you start, in increasing order of complexity:

| Feature      | Path                          | Shape                                                            |
| ------------ | ----------------------------- | ---------------------------------------------------------------- |
| `start`      | `features/start/src/index.ts` | One file. A command and a string.                                |
| `help`       | `features/help/src/index.ts`  | One file, plus a construction-time option.                       |
| `users`      | `features/users/src/**`       | `domain/` + `application/` + `infrastructure/`. No `BotFeature`. |
| `downloader` | `features/downloader/src/**`  | All four layers, queue, cache, worker use cases.                 |

Note that `users` is a feature workspace that does **not** export a `BotFeature`.
It exports a repository and a use case that the bot's middleware consumes. If
your feature has no handlers of its own, that is a legitimate shape.

---

## 1. The contract

`packages/telegram/src/feature.ts`:

```ts
export interface BotFeature {
  readonly name: string;
  readonly composer: Composer<AppContext>;
  /** Advertised via `setMyCommands`, so `/help` and the menu stay in step. */
  readonly commands?: readonly FeatureCommand[];
}

export interface FeatureCommand {
  readonly command: string;
  readonly description: string;
}
```

That is the whole surface. `apps/bot/src/register-features.ts` never reaches into
a feature's handlers, use cases or repositories — it calls `bot.use(feature.composer)`
and collects `feature.commands`.

`AppContext` (`packages/telegram/src/context.ts`) is `grammy`'s `Context` plus the
three fields the middleware stack attaches:

```ts
export interface AppContextFlavor {
  requestId: string;
  logger: Logger;
  user: SessionUser;
}
```

`ctx.user` is populated by `userContext` middleware in `apps/bot/src/bootstrap.ts`,
which runs before any feature composer. If you register a handler that can fire on
an update with no `from` (a channel post, for instance), use `hasSessionUser(ctx)`
rather than trusting the type.

---

## 2. Create the workspace

```bash
mkdir -p features/text-tools/src
```

### `features/text-tools/package.json`

Copy this verbatim from `features/start/package.json`, changing only the name.
The scope pattern is `@tgtools/feature-<name>` — the directory name and the
package name after the `feature-` prefix should match, because
`vitest.config.ts` and `tests/tsconfig.json` both map one onto the other.

```json
{
  "name": "@tgtools/feature-text-tools",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check-types": "tsc -p tsconfig.json --noEmit",
    "clean": "rimraf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@tgtools/shared": "*",
    "@tgtools/telegram": "*",
    "grammy": "^1.45.1"
  },
  "devDependencies": {
    "@types/node": "^22.20.1",
    "rimraf": "^6.0.1",
    "typescript": "^5.9.3"
  }
}
```

Workspace dependencies use `"*"`, not a version — the root `package.json`
declares `"workspaces": ["apps/*", "packages/*", "features/*"]`, so npm links them
from the tree.

### `features/text-tools/tsconfig.json`

Identical in every feature and package:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist", "node_modules"]
}
```

The `src/**/*.test.ts` exclusion matters later — see the ESLint note in §4.

`tsconfig.base.json` sets `"module": "NodeNext"`, so **every relative import must
carry a `.js` extension** even though the file on disk is `.ts`:

```ts
import { createTextToolsFeature } from './text-tools.feature.js';
```

Then:

```bash
npm install          # links the new workspace
```

`turbo.json` needs no change; `turbo run build` discovers workspaces from the root
manifest.

---

## 3. The layers

For a one-command feature, a single `src/index.ts` is the honest shape — that is
what `start` and `help` do. Introduce layers when the feature has state, IO, or a
decision worth testing without a Telegram update object.

```
features/text-tools/src/
  index.ts                    ← the package's public surface (re-exports only)
  text-tools.feature.ts       ← composition root: builds everything, returns the BotFeature
  domain/                     ← entities, value objects, errors, PORTS. No frameworks.
  application/                ← use cases. Talks to ports only.
  infrastructure/             ← adapters: drizzle, ioredis, bullmq, HTTP clients.
  presentation/telegram/      ← handlers, keyboards, presenters, message tables.
```

What goes where, as practised in `features/downloader`:

- **`domain/`** — `entities/` (`download-job.ts`, `job-status.ts`), `value-objects/`
  (`media-url.ts`, `job-id.ts`), `errors/` (`download-error.ts`,
  `download-failure-code.ts`) and `ports/` — the interfaces the outer layers must
  satisfy (`media-downloader.port.ts`, `download-job.repository.ts`). Pure data and
  pure functions. `job-status.ts` is a good model: the state machine is a frozen
  table plus `assertTransition`, with no idea that a database exists.
- **`application/`** — one class per use case (`process-download.use-case.ts`,
  `request-download.use-case.ts`), constructor-injected with ports. Also
  `services/` for stateful helpers with no IO (`progress-throttler.ts`).
- **`infrastructure/`** — the drivers. `persistence/drizzle-*.repository.ts`,
  `queue/bullmq-download-queue.ts`, `cache/redis-*.ts`, `telegram/grammy-*.ts`,
  `providers/` for the engine adapter.
- **`presentation/telegram/`** — `handlers/` (thin: read update → build command →
  call use case → render), `keyboards/`, `presenters/`, and `messages/fa.ts`, which
  holds every user-visible string. Keep it that way: `fa.test.ts` asserts that no
  message contains `yt-dlp`, `ffmpeg`, `undefined` or `NaN`.

The feature file itself is the composition root. `features/downloader/src/downloader.feature.ts`
constructs the repositories, the cache, the policy and the use cases, builds a
`Composer`, and returns an object whose `botFeature` field is the `BotFeature`:

```ts
const composer = new Composer<AppContext>();
composer.callbackQuery(
  DOWNLOAD_CALLBACK_PATTERN,
  createDownloadCallbackHandler({ requestDownload, cancelDownload, getStatus, cache }),
);
composer.on(['message:text', 'message:caption'], createLinkMessageHandler({ inspectMedia }));

return {
  botFeature: { name: 'downloader', composer },
  processDownload,
  cleanupExpired,
  // …
};
```

---

## 4. The layer boundaries are enforced, not documented

`eslint.config.js` defines the list of packages that make a file "infrastructure"
by definition:

```js
const FRAMEWORK_PACKAGES = [
  'grammy',
  'grammy/*',
  '@grammyjs/*',
  'bullmq',
  'ioredis',
  'drizzle-orm',
  'drizzle-orm/*',
  'postgres',
  'pino',
  'ytdlp-nodejs',
  '@tgtools/database',
  '@tgtools/queue',
  '@tgtools/telegram',
  '@tgtools/downloader-engine',
];
```

and then applies it by path:

```js
  {
    files: ['features/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'domain/ must stay framework-free. Define a port and adapt it outside.',
            },
            {
              group: ['**/application', '**/application/**', ...OUTWARD_LAYER_PATHS],
              message: 'domain/ may not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['features/*/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'application/ talks to ports only, never to a driver.',
            },
            {
              group: OUTWARD_LAYER_PATHS,
              message: 'application/ may not depend on infrastructure or presentation.',
            },
          ],
        },
      ],
    },
  },
```

`OUTWARD_LAYER_PATHS` is `['**/infrastructure', '**/infrastructure/**', '**/presentation', '**/presentation/**']`.

So `import { Queue } from 'bullmq'` inside `features/text-tools/src/domain/thing.ts`
fails `npm run lint` with _"domain/ must stay framework-free. Define a port and
adapt it outside."_ The `files` globs are literal: the rule only fires for
directories named exactly `domain` and `application` directly under
`features/<name>/src/`. Naming them `core/` and `services/` silently opts out of
the check.

Other rules from the same file that bite in new code:

- `no-restricted-globals` bans `process` — _"Read configuration through
  `@tgtools/config` instead."_ Only `packages/config/src/**` and `infra/scripts/**`
  are exempt.
- `no-console` is an error. Take a `Logger` (`@tgtools/shared`) instead.
- `@typescript-eslint/explicit-module-boundary-types` and `no-explicit-any` are on.
- `@typescript-eslint/consistent-type-imports` — type-only imports must be
  `import type`.
- `import-x/no-cycle` at `maxDepth: 8`.

Tests are relaxed: the block matching `['**/*.test.ts', 'tests/**/*.ts']` extends
`tseslint.configs.disableTypeChecked` and turns off `no-restricted-imports`,
`no-restricted-globals`, `no-console` and `no-non-null-assertion`. The comment
explains why type checking is off there — test files are excluded from each
package's `tsconfig.json`, so the type-aware parser has no program for them.

---

## 5. Register it in the bot

`apps/bot/src/register-features.ts`:

```ts
const features: BotFeature[] = [
  createStartFeature(),
  createHelpFeature({
    maxUploadMegabytes: Math.floor(bytesToMegabytes(container.config.limits.maxUploadBytes)),
  }),
  container.downloader.botFeature,
];

for (const feature of features) {
  container.bot.use(feature.composer);
  container.logger.debug('feature registered', { feature: feature.name });
}

const commands = features.flatMap((feature) => feature.commands ?? []);
```

**Order matters.** grammY runs composers in sequence, and the downloader's second
handler is a catch-all:

```ts
composer.on(['message:text', 'message:caption'], createLinkMessageHandler({ inspectMedia }));
```

Anything that handles a _command_ has to be registered before it, or the downloader
sees the command's argument and treats it as a URL. (`createLinkMessageHandler`
does guard against this itself — `extractUrls` returns `isCommand`, and the handler
returns early — but the ordering rule is what the composition root is expected to
maintain, and a feature that reacts to plain text without a command prefix has no
such escape hatch.)

If your feature is command-driven, insert it **above** `container.downloader.botFeature`.

Anything constructed from configuration or shared infrastructure goes through
`apps/bot/src/container.ts` first — that is the process's only composition root.
`createStartFeature()` takes nothing, `createHelpFeature({...})` takes a value read
off `container.config`, and the downloader is built in the container itself.

---

## 6. Wire the dependency

`apps/bot/package.json`, `dependencies`:

```json
    "@tgtools/feature-text-tools": "*",
```

And — easy to miss — **both Dockerfiles list every workspace manifest explicitly**
so the dependency-install layer survives source changes. `Dockerfile.bot` and
`Dockerfile.worker` each contain:

```dockerfile
COPY features/downloader/package.json features/downloader/
COPY features/help/package.json features/help/
COPY features/start/package.json features/start/
COPY features/users/package.json features/users/
```

Add a line for the new feature to both, or `npm ci` inside the image fails with a
lockfile/workspace mismatch.

---

## 7. If the feature needs background work

The pattern is the one `downloader` uses: the feature factory returns both the
`BotFeature` **and** the use cases, and each process takes what it needs.

`features/downloader/src/downloader.feature.ts`:

```ts
export interface DownloaderFeature {
  readonly botFeature: BotFeature;
  readonly processDownload: ProcessDownloadUseCase;
  readonly cleanupExpired: CleanupExpiredDownloadsUseCase;
  readonly getStatus: GetDownloadStatusUseCase;
  readonly jobs: DownloadJobRepository;
  readonly cache: MediaInspectionCache;
  readonly downloader: MediaDownloaderPort;
}
```

Concretely:

1. **Name the queue** in `packages/queue/src/queue-names.ts`. `QueueName` already
   declares `MediaInspect`, `MediaDownload` and `Maintenance`; only `MediaDownload`
   currently has a producer and a worker.
2. **Define and validate the payload** in your own `infrastructure/queue/`. See
   `bullmq-download-queue.ts`: a Zod schema plus `parseDownloadJobPayload`, because
   a message sits in Redis across deploys and the worker reading it may be a newer
   build than the bot that wrote it.
3. **Produce** from the bot: `createQueue<Payload>({ name, connection: redis.client, config })`
   in `apps/bot/src/container.ts`, handed into your feature factory.
4. **Consume** in the worker: add the feature to `apps/worker/package.json` and
   `apps/worker/src/container.ts`, then a `apps/worker/src/workers/<name>.worker.ts`
   calling `createWorker(...)` from `@tgtools/queue`, and a
   `apps/worker/src/processors/<name>.processor.ts` that does nothing but translate
   one delivery into one use-case call.
5. **Start it** in `apps/worker/src/bootstrap.ts` and **stop it** in
   `apps/worker/src/shutdown/worker-shutdown-steps.ts`. Shutdown steps run in the
   listed order; put "stop accepting work" first.
6. If jobs are long-running and cancellable, register their `AbortController` with
   `container.running` (`apps/worker/src/job-registry.ts`) so a cancellation
   broadcast can actually reach the running process.

Purely periodic work does not need a queue at all. `startMaintenanceLoop`
(`apps/worker/src/workers/maintenance.worker.ts`) is a plain `setInterval` with an
overlap guard, because the work is idempotent and losing a tick costs nothing.

---

## 8. Tests

- Unit tests live **next to the source**: `features/text-tools/src/**/*.test.ts`.
  They are picked up by the `unit` vitest project and excluded from the package's
  `tsconfig.json`.
- `vitest.config.ts` builds its workspace aliases by scanning `packages/` and
  `features/` for a `package.json` + `src/index.ts` pair, so a new feature is
  importable as `@tgtools/feature-text-tools` from any test with no config change.
- Cross-feature tests under `tests/` **do** need a manual entry in the `paths` map
  in `tests/tsconfig.json`, which exists so `npm run check-types` can type-check
  the suite.

See `docs/testing.md`.

---

## Checklist

- [ ] `features/<name>/package.json` named `@tgtools/feature-<name>`, `"private": true`, `"type": "module"`, `main`/`types`/`exports` pointing at `dist`.
- [ ] `features/<name>/tsconfig.json` extending `../../tsconfig.base.json`, excluding `src/**/*.test.ts`.
- [ ] `features/<name>/src/index.ts` re-exports the factory and the public types.
- [ ] Relative imports carry the `.js` extension.
- [ ] Layers named exactly `domain/`, `application/`, `infrastructure/`, `presentation/` if you use them.
- [ ] No `grammy`, `bullmq`, `ioredis`, `drizzle-orm`, `postgres`, `pino` or `@tgtools/{database,queue,telegram,downloader-engine}` under `domain/` or `application/`.
- [ ] No `process`, no `console`.
- [ ] User-facing strings in one message table, not inline.
- [ ] `npm install` run so the workspace is linked.
- [ ] Added to `apps/bot/package.json` dependencies.
- [ ] Added to the `COPY .../package.json` block in **both** `Dockerfile.bot` and `Dockerfile.worker`.
- [ ] Registered in `apps/bot/src/register-features.ts`, before the downloader if it is command-driven.
- [ ] Commands declared on the `BotFeature` so `setMyCommands` picks them up.
- [ ] Worker wiring done if it needs background work (queue name, payload schema, container, worker, processor, bootstrap, shutdown step).
- [ ] Added to `tests/tsconfig.json` `paths` if anything under `tests/` imports it.
- [ ] `npm run lint && npm run check-types && npm test && npm run build` all pass.
