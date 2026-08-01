export { createDatabase } from './client.js';
export type { CreateDatabaseOptions, DatabaseHandle, Db } from './client.js';
export { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
export { assertEnumCovers, checkEnumDrift, readEnumValues } from './schema-guard.js';
export type { EnumDriftReport } from './schema-guard.js';
export type { RunMigrationsOptions } from './migrate.js';
export * as schema from './schema/index.js';
export {
  downloadEvents,
  downloadJobs,
  jobStatusEnum,
  mediaInspections,
  mediaTypeEnum,
  platformEnum,
  users,
} from './schema/index.js';
export type {
  DownloadEventRow,
  DownloadJobRow,
  MediaInspectionRow,
  NewDownloadEventRow,
  NewDownloadJobRow,
  NewMediaInspectionRow,
  NewUserRow,
  UserRow,
} from './schema/index.js';
