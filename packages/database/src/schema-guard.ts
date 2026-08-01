import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * The values a Postgres enum currently holds.
 *
 * `enum_range` is the only way to ask; there is no catalogue view that gives
 * the values in one column without a join.
 */
export async function readEnumValues(db: Db, enumName: string): Promise<string[]> {
  const rows = await db.execute<{ value: string }>(
    sql`select unnest(enum_range(null::${sql.raw(`"${enumName}"`)}))::text as value`,
  );
  // postgres-js returns an array-like; drizzle's typing varies by driver, so
  // normalise defensively rather than assume a shape.
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list
    .map((row) => (row as { value?: unknown }).value)
    .filter((value): value is string => typeof value === 'string');
}

export interface EnumDriftReport {
  readonly enumName: string;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

/**
 * Compare a database enum against the vocabulary the code believes in.
 *
 * This exists because of a specific, expensive failure mode: adding a platform
 * without applying the migration leaves every job for it failing at INSERT
 * time, and the resulting error is a four-thousand-character SQL dump whose
 * real cause — `invalid input value for enum media_platform: "youtube"` — is
 * buried in a wrapped `cause`. Checking up front turns that into one sentence
 * naming the missing value.
 *
 * `unexpected` values are reported but are NOT an error: an enum can legally
 * hold a value the running build has removed, and Postgres offers no supported
 * way to drop one.
 */
export async function checkEnumDrift(
  db: Db,
  enumName: string,
  expected: readonly string[],
): Promise<EnumDriftReport> {
  const actual = new Set(await readEnumValues(db, enumName));
  return {
    enumName,
    missing: expected.filter((value) => !actual.has(value)),
    unexpected: [...actual].filter((value) => !expected.includes(value)),
  };
}

/** Throws with an actionable message when the database is behind the code. */
export async function assertEnumCovers(
  db: Db,
  enumName: string,
  expected: readonly string[],
): Promise<void> {
  const report = await checkEnumDrift(db, enumName, expected);
  if (report.missing.length === 0) return;
  throw new Error(
    `Database enum "${enumName}" is missing ${report.missing.map((value) => `"${value}"`).join(', ')}. ` +
      `The schema is behind the code. Either the migration has not been applied, or the ` +
      `migrate image predates it — rebuild every service (\`docker compose build --no-cache\`, ` +
      `with no service list) and re-run \`docker compose run --rm migrate\`.`,
  );
}
