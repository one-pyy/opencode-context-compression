import {
  createResultGroup,
  listResultGroups,
  readResultGroup,
  upsertResultGroup,
} from "./result-groups.js";
import { openLockedSessionSidecarDatabase } from "./schema.js";
import { allocateVisibleID, listVisibleIDs, readVisibleID } from "./visible-ids.js";
import { readPendingCompactions } from "./pending-compactions.js";
import type {
  OpenSessionSidecarRepositoryOptions,
  SessionSidecarRepository,
} from "./types.js";
import type { SqliteDatabase } from "../sqlite-runtime.js";

export interface SessionSidecarRepositoryWithDatabase extends SessionSidecarRepository {
  readonly database: SqliteDatabase;
}

export async function openSessionSidecarRepository(
  options: OpenSessionSidecarRepositoryOptions,
): Promise<SessionSidecarRepositoryWithDatabase> {
  const database = await openLockedSessionSidecarDatabase(options.databasePath);

  return {
    database,
    allocateVisibleID(visibleIDOptions) {
      return allocateVisibleID(database, visibleIDOptions);
    },
    readVisibleID(canonicalID) {
      return readVisibleID(database, canonicalID);
    },
    listVisibleIDs() {
      return listVisibleIDs(database);
    },
    createResultGroup(resultGroup) {
      return createResultGroup(database, resultGroup);
    },
    readResultGroup(markID) {
      return readResultGroup(database, markID);
    },
    getResultGroupByMarkID(markID) {
      return readResultGroup(database, markID);
    },
    listResultGroups() {
      return listResultGroups(database);
    },
    upsertResultGroup(resultGroup) {
      return upsertResultGroup(database, resultGroup);
    },
    listPendingMarkIds() {
      return readPendingCompactions(database).map((p) => p.markId);
    },
    close() {
      database.close();
    },
  };
}
