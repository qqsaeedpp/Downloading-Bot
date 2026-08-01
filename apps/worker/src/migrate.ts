import { loadConfig } from '@tgtools/config';
import { runMigrations } from '@tgtools/database';
import { createLogger } from '@tgtools/logger';
import { describeError } from '@tgtools/shared';

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
 * outside every package is one that the Dockerfile forgets to copy, which is
 * exactly how this broke the first time.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ config, service: 'migrate' });
  await runMigrations({ databaseUrl: config.database.url, logger });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: migration failed: ${describeError(error)}\n`);
  process.exit(1);
});
