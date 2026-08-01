import { loadConfig } from '@tgtools/config';
import { assertEnumCovers, createDatabase, runMigrations } from '@tgtools/database';
import { createLogger } from '@tgtools/logger';
import { ALL_MEDIA_PLATFORMS, describeError } from '@tgtools/shared';

/**
 * Standalone migration entry point.
 *
 * Deliberately NOT run from the bot or the worker on startup: two replicas
 * booting at once would race on the same DDL, and a failed migration should
 * stop a deploy rather than crash-loop a service. Compose runs this as a
 * one-shot container that both services wait on.
 *
 * It lives inside the worker app rather than in `infra/scripts/` so that it is
 * compiled by the same build and shipped in the same image — a loose `.ts` file
 * outside every package is one that the Dockerfile forgets to copy.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ config, service: 'migrate' });

  await runMigrations({ databaseUrl: config.database.url, logger });

  // Verify, rather than trust the exit code.
  //
  // "No pending migrations" and "this image does not contain the migration you
  // think it does" look identical from the outside: both apply nothing and
  // exit 0. That is exactly how a deploy that rebuilt only `bot` and `worker`
  // left the platform enum a version behind, with every job for the new
  // platform failing at INSERT and nothing in the migrate log to explain it.
  const database = createDatabase({ config, logger });
  try {
    await assertEnumCovers(database.db, 'media_platform', ALL_MEDIA_PLATFORMS);
    logger.info('schema is up to date', { platforms: ALL_MEDIA_PLATFORMS.length });
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: migration failed: ${describeError(error)}\n`);
  process.exit(1);
});
