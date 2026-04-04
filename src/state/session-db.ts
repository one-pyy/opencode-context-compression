import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { applyStateSchemaMigrations } from "./schema.js";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite-runtime.js";

export const DEFAULT_SESSION_DATABASE_DIRECTORY_NAME = "state";
export const DEFAULT_SESSION_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export interface OpenSessionDatabaseOptions {
  readonly pluginDirectory: string;
  readonly sessionID: string;
  readonly stateDirectoryName?: string;
  readonly busyTimeoutMs?: number;
  readonly now?: () => number;
}

export interface SessionDatabaseHandle {
  readonly database: SqliteDatabase;
  readonly databasePath: string;
  close(): void;
}

export function resolvePluginStateDirectory(
  pluginDirectory: string,
  stateDirectoryName = DEFAULT_SESSION_DATABASE_DIRECTORY_NAME,
): string {
  return join(pluginDirectory, stateDirectoryName);
}

export function resolveSessionDatabasePath(
  pluginDirectory: string,
  sessionID: string,
  stateDirectoryName = DEFAULT_SESSION_DATABASE_DIRECTORY_NAME,
): string {
  return join(resolvePluginStateDirectory(pluginDirectory, stateDirectoryName), `${sessionID}.db`);
}

export function openSessionDatabase(options: OpenSessionDatabaseOptions): SessionDatabaseHandle {
  const stateDirectory = resolvePluginStateDirectory(
    options.pluginDirectory,
    options.stateDirectoryName,
  );
  mkdirSync(stateDirectory, { recursive: true });

  const databasePath = resolveSessionDatabasePath(
    options.pluginDirectory,
    options.sessionID,
    options.stateDirectoryName,
  );
  const database = createSqliteDatabase(databasePath, {
    enableForeignKeyConstraints: true,
  });

  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`PRAGMA busy_timeout = ${normalizeBusyTimeoutMs(options.busyTimeoutMs)}`);
  applyStateSchemaMigrations(database, options.now);

  return {
    database,
    databasePath,
    close() {
      if (database.isOpen) {
        database.close();
      }
    },
  };
}

function normalizeBusyTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_DATABASE_BUSY_TIMEOUT_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid SQLite busy timeout: ${value}`);
  }

  return Math.trunc(value);
}
