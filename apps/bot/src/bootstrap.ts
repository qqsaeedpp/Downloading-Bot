import { access, constants } from 'node:fs/promises';
import { loadConfig } from '@tgtools/config';
import {
  describePotProviderProblem,
  probePotProvider,
  reportCookieAccess,
} from '@tgtools/downloader-engine';
import { assertEnumCovers } from '@tgtools/database';
import type { Logger } from '@tgtools/shared';
import {
  ALL_MEDIA_PLATFORMS,
  describeError,
  healthCheck,
  installGracefulShutdown,
  startHealthServer,
} from '@tgtools/shared';
import { createBotContainer } from './container.js';
import { createErrorBoundary } from './middleware/error-boundary.js';
import { rateLimit } from './middleware/rate-limit.middleware.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { userContext } from './middleware/user.middleware.js';
import { registerFeatures } from './register-features.js';
import { buildBotShutdownSteps } from './shutdown/bot-shutdown-steps.js';

/**
 * The bot process.
 *
 * It receives updates, answers questions and puts work on a queue. It never
 * downloads, never runs FFmpeg and never writes a media file — a single 400 MB
 * pull in here would block every other user's update for as long as it ran.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createBotContainer(config);
  const { logger, bot } = container;

  // `version` and `env` are already on every line via the logger's base
  // bindings; repeating them here would emit a duplicated JSON key.
  //
  // The toolchain is probed here too, even though this process never downloads:
  // extraction is what needs the JavaScript runtime, and extraction is exactly
  // what the bot does.
  const toolchain = await container.engine.engine.probeToolchain();
  logger.info('starting bot', {
    node: process.version,
    ytDlp: toolchain.ytDlpVersion ?? 'unknown',
    jsRuntime: toolchain.jsRuntimeVersion ?? 'MISSING',
  });
  warnIfNoJsRuntime(logger, toolchain.jsRuntimeVersion);

  // Verified at startup, not on the first user's link. "I set the variable and
  // it still says bot check" has two completely different causes -- the provider
  // is unreachable, or it answered and was not enough -- and only one of them is
  // worth more of the operator's evening.
  const potStatus = await probePotProvider(config.extraction.potProviderUrl);
  logger.info('PO token provider', { status: potStatus.kind });
  const potProblem = describePotProviderProblem(potStatus);
  if (potProblem !== undefined) logger.error(potProblem);

  // Read now, not on the first job that needs one. The bot and the worker mount
  // their cookies separately, and the way that divergence surfaces otherwise is
  // a video that lists every quality and then fails the moment a user picks one.
  const cookieReports = await reportCookieAccess(config.cookies, logger);
  if (cookieReports.length > 0) {
    logger.info('cookie files', {
      cookies: Object.fromEntries(cookieReports.map((r) => [r.platform, r.kind])),
    });
  }

  // Middleware order is the security order: identity before rate limiting,
  // rate limiting before anything that costs time or money.
  bot.use(requestContext({ logger, ids: container.ids }));
  bot.use(
    rateLimit({
      redis: container.redis.client,
      windowMs: config.limits.rateLimitWindowMs,
      maxRequests: config.limits.rateLimitMaxRequests,
    }),
  );
  bot.use(userContext({ registerOrUpdateUser: container.registerOrUpdateUser }));

  const { commands } = registerFeatures(container);
  bot.catch(createErrorBoundary(logger));

  const health = await startHealthServer({
    port: config.health.botPort,
    service: 'bot',
    version: config.version,
    logger,
    checks: [
      healthCheck('postgres', () => container.database.ping()),
      healthCheck('redis', () => container.redis.ping()),
      // Catches the deploy that rebuilt the images but skipped the migration.
      // Without it, the symptom is every job for the new platform failing at
      // INSERT with a SQL dump instead of a sentence.
      healthCheck('platform-enum', () =>
        assertEnumCovers(container.database.db, 'media_platform', ALL_MEDIA_PLATFORMS),
      ),
      // yt-dlp, and ONLY yt-dlp. The bot inspects; it never decodes, muxes or
      // re-encodes, so asserting FFmpeg here would fail a container that is
      // working perfectly — and would be a standing invitation to install a
      // dependency this process has no use for.
      healthCheck('yt-dlp', () => assertExecutable(config.binaries.ytDlp)),
    ],
  });

  installGracefulShutdown({
    logger,
    timeoutMs: 20_000,
    steps: buildBotShutdownSteps(container, health),
  });

  await bot.api.setMyCommands([...commands]);

  // `start` resolves only once the bot stops, so awaiting it here would mean
  // shutdown never gets a turn.
  void bot.start({
    // Only the update types the features handle; anything else costs a round
    // trip and a middleware pass for nothing.
    allowed_updates: ['message', 'callback_query'],
    onStart: (info) => {
      logger.info('bot is listening', { username: info.username, id: info.id });
    },
  });
}

/**
 * Only meaningful for an absolute path. A bare command name — the schema
 * default — is resolved by the OS at spawn time, so there is nothing to stat.
 */
async function assertExecutable(path: string): Promise<void> {
  if (!path.includes('/') && !path.includes('\\')) return;
  await access(path, constants.X_OK);
}

/**
 * Loud, but not fatal.
 *
 * Since yt-dlp 2025.11.12 a JavaScript runtime is required to solve YouTube's
 * player challenge; without one the format list comes back empty or heavily
 * reduced, which is indistinguishable from a post that has no media. It affects
 * exactly one platform, so refusing to start would take the other four with it.
 */
function warnIfNoJsRuntime(logger: Logger, version: string | undefined): void {
  if (version !== undefined) return;
  logger.error(
    'no JavaScript runtime found — YouTube extraction will return few formats or none. ' +
      'Install Deno (the images do this via the DENO_VERSION build arg) or set DENO_PATH. ' +
      'Every other platform is unaffected.',
  );
}

main().catch((error: unknown) => {
  // Nothing is wired yet, so there is no logger and no shutdown to run. Write
  // to stderr and let the orchestrator see the non-zero exit.
  process.stderr.write(`fatal: bot failed to start: ${describeError(error)}\n`);
  process.exit(1);
});
