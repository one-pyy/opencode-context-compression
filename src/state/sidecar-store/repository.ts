import {
  createResultGroup,
  listResultGroups,
  readResultGroup,
  upsertResultGroup,
} from "./result-groups.js";
import { openLockedSessionSidecarDatabase } from "./schema.js";
import { allocateVisibleID, listVisibleIDs, readVisibleID } from "./visible-ids.js";
import type {
  OpenSessionSidecarRepositoryOptions,
  SessionSidecarRepository,
} from "./types.js";

export async function openSessionSidecarRepository(
  options: OpenSessionSidecarRepositoryOptions,
): Promise<SessionSidecarRepository> {
  const database = await openLockedSessionSidecarDatabase(options.databasePath);

  return {
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
    close() {
      database.close();
    },
  };
}
