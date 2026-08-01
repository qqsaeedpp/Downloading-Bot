import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@tgtools/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Migrations live at the repository root, not inside this package, so that the
 * SQL is reviewable in one place and the same folder is mounted by the
 * migration container.
 */
export const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'migrations',
);

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  readonly logger: Logger;
  readonly migrationsFolder?: string;
}

/**
 * Apply pending migrations and disconnect.
 *
 * Uses a dedicated single connection (`max: 1`) because Drizzle takes an
 * advisory lock for the run: sharing the application pool would let a second
 * statement interleave with a DDL transaction.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const client = postgres(options.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    options.logger.info('applying database migrations', { folder });
    await migrate(drizzle(client), { migrationsFolder: folder });
    options.logger.info('database migrations applied');
  } finally {
    await client.end({ timeout: 5 });
  }
}
