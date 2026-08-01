import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only ever runs from a developer machine or CI, never inside the
 * running services, so reading the environment directly here is deliberate.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/database/src/schema/index.ts',
  out: './infra/migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/telegram_tools',
  },
});
