import { createRequire } from "node:module";

export interface SqliteStatement<Row extends Record<string, unknown> = Record<string, unknown>> {
  get(parameters?: Record<string, unknown>): Row | undefined;
  all(parameters?: Record<string, unknown>): Row[];
  run(parameters?: Record<string, unknown>): unknown;
}

export interface SqliteDatabase {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatement<Row>;
  close(): void;
}

export interface SqliteDatabaseOpenOptions {
  readonly enableForeignKeyConstraints?: boolean;
}

interface SqliteDatabaseConstructor {
  new (databasePath: string, options?: SqliteDatabaseOpenOptions): SqliteDatabase;
}

interface SqliteModule {
  readonly DatabaseSync: SqliteDatabaseConstructor;
}

interface BunSqliteStatement<Row extends Record<string, unknown> = Record<string, unknown>> {
  get(parameters?: Record<string, unknown>): Row | undefined;
  all(parameters?: Record<string, unknown>): Row[];
  run(parameters?: Record<string, unknown>): unknown;
}

interface BunSqliteDatabase {
  exec(sql: string): void;
  prepare<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): BunSqliteStatement<Row>;
  close(throwOnError?: boolean): void;
}

interface BunSqliteDatabaseConstructor {
  new (databasePath: string, options?: { readonly create?: boolean; readonly readwrite?: boolean }): BunSqliteDatabase;
}

interface BunSqliteModule {
  readonly Database: BunSqliteDatabaseConstructor;
}

const runtimeRequire = createRequire(import.meta.url);

let cachedModule: SqliteModule | undefined;
let cachedBunModule: BunSqliteModule | undefined;

export function createSqliteDatabase(
  databasePath: string,
  options?: SqliteDatabaseOpenOptions,
): SqliteDatabase {
  const nodeSqlite = tryLoadNodeSqliteModule();
  if (nodeSqlite !== undefined) {
    return new nodeSqlite.DatabaseSync(databasePath, options);
  }

  const bunSqlite = tryLoadBunSqliteModule();
  if (bunSqlite !== undefined) {
    return createBunDatabaseAdapter(databasePath, bunSqlite);
  }

  throw new Error("Failed to load a supported SQLite runtime. Neither node:sqlite nor bun:sqlite is available.");
}

function tryLoadNodeSqliteModule(): SqliteModule | undefined {
  if (cachedModule !== undefined) {
    return cachedModule;
  }

  const loaded = tryRequire(resolveNodeSqliteSpecifier());
  if (loaded === undefined) {
    return undefined;
  }

  if (!isSqliteModule(loaded)) {
    throw new Error("Failed to load node:sqlite runtime: DatabaseSync export is missing.");
  }

  cachedModule = loaded;
  return cachedModule;
}

function tryLoadBunSqliteModule(): BunSqliteModule | undefined {
  if (cachedBunModule !== undefined) {
    return cachedBunModule;
  }

  const loaded = tryRequire(resolveBunSqliteSpecifier());
  if (loaded === undefined) {
    return undefined;
  }

  if (!isBunSqliteModule(loaded)) {
    throw new Error("Failed to load bun:sqlite runtime: Database export is missing.");
  }

  cachedBunModule = loaded;
  return cachedBunModule;
}

function createBunDatabaseAdapter(databasePath: string, sqlite: BunSqliteModule): SqliteDatabase {
  const database = new sqlite.Database(databasePath, {
    create: true,
    readwrite: true,
  });
  let open = true;
  let inTransaction = false;

  return {
    get isOpen() {
      return open;
    },
    get isTransaction() {
      return inTransaction;
    },
    exec(sql: string) {
      trackTransactionState(sql, {
        begin() {
          inTransaction = true;
        },
        settle() {
          inTransaction = false;
        },
      });
      database.exec(sql);
    },
    prepare<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatement<Row> {
      const statement = database.prepare<Row>(sql);
      return {
        get(parameters?: Record<string, unknown>) {
          const row = statement.get(normalizeBunParameters(parameters));
          // Bun's SQLite returns null (not undefined) when no row is found.
          // Normalize to undefined to match the SqliteStatement contract.
          return (row ?? undefined) as Row | undefined;
        },
        all(parameters?: Record<string, unknown>) {
          return statement.all(normalizeBunParameters(parameters)) as Row[];
        },
        run(parameters?: Record<string, unknown>) {
          return statement.run(normalizeBunParameters(parameters));
        },
      };
    },
    close() {
      if (!open) {
        return;
      }

      database.close(false);
      open = false;
      inTransaction = false;
    },
  };
}

function resolveNodeSqliteSpecifier(): string {
  return ["node", "sqlite"].join(":");
}

function resolveBunSqliteSpecifier(): string {
  return ["bun", "sqlite"].join(":");
}

function tryRequire(specifier: string): unknown {
  try {
    return runtimeRequire(specifier);
  } catch (error) {
    if (isMissingBuiltinModuleError(error) || isMissingModuleError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingBuiltinModuleError(error: unknown): boolean {
  return readErrorMessage(error).includes("No such built-in module");
}

function isMissingModuleError(error: unknown): boolean {
  return readErrorMessage(error).includes("Cannot find module");
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as { message?: unknown; toString?: () => string };
    if (typeof record.message === "string") {
      return record.message;
    }

    if (typeof record.toString === "function") {
      return record.toString();
    }
  }

  return String(error);
}

function isSqliteModule(value: unknown): value is SqliteModule {
  const record = asRecord(value);
  return typeof record?.DatabaseSync === "function";
}

function isBunSqliteModule(value: unknown): value is BunSqliteModule {
  const record = asRecord(value);
  return typeof record?.Database === "function";
}

function trackTransactionState(
  sql: string,
  tracker: {
    begin(): void;
    settle(): void;
  },
): void {
  const normalized = sql.trim().toUpperCase();
  if (normalized === "BEGIN" || normalized.startsWith("BEGIN ")) {
    tracker.begin();
    return;
  }

  if (normalized === "COMMIT" || normalized.startsWith("COMMIT ")) {
    tracker.settle();
    return;
  }

  if (normalized === "ROLLBACK" || normalized.startsWith("ROLLBACK ")) {
    tracker.settle();
  }
}

function normalizeBunParameters(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (parameters === undefined) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    normalized[key] = value;
    if (!startsWithSqliteParameterPrefix(key)) {
      normalized[`:${key}`] = value;
    }
  }

  return normalized;
}

function startsWithSqliteParameterPrefix(key: string): boolean {
  return key.startsWith(":") || key.startsWith("$") || key.startsWith("@");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}
