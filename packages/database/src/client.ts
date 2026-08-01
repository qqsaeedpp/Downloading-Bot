import type { AppConfig } from '@tgtools/config';
import type { Logger } from '@tgtools/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Db;
  /** Cheap round trip for the readiness probe. */
  ping(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
}

export function createDatabase({ config, logger }: CreateDatabaseOptions): DatabaseHandle {
  const client = postgres(config.database.url, {
    max: config.database.poolMax,
    // Bounded, so a query against an unreachable server fails instead of
    // queueing behind an indefinite reconnect. The readiness probe depends on
    // this: without it, `ping()` never settles.
    connect_timeout: 10,
    // Everything is stored and compared in UTC; letting the server's local zone
    // leak in is how "expired an hour ago" becomes "expires in two hours".
    connection: { TimeZone: 'UTC' },
    onnotice: (notice) => {
      logger.debug('postgres notice', { message: notice.message });
    },
  });

  const db = drizzle(client, { schema });

  return {
    db,
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    async close(): Promise<void> {
      // `{ timeout: 5 }` lets in-flight statements finish instead of severing
      // them, which would surface as a spurious error during a clean shutdown.
      await client.end({ timeout: 5 });
      logger.debug('database connection closed');
    },
  };
}
