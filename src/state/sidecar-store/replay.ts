import type { SqliteDatabase } from "../sqlite-runtime.js";
import { runInTransaction } from "./helpers.js";
import { insertCommittedResultGroup } from "./result-groups.js";
import { openLockedSessionSidecarDatabase } from "./schema.js";
import { insertVisibleSequenceAllocations } from "./visible-ids.js";
import type {
  RebuildSessionSidecarFromReplayOptions,
  SessionSidecarReplayState,
} from "./types.js";

export async function rebuildSessionSidecarFromReplay(
  options: RebuildSessionSidecarFromReplayOptions,
): Promise<void> {
  const database = await openLockedSessionSidecarDatabase(options.databasePath);

  try {
    replaceReplayDerivedData(database, options.replayState);
  } finally {
    database.close();
  }
}

function replaceReplayDerivedData(
  database: SqliteDatabase,
  replayState: SessionSidecarReplayState,
): void {
  assertReplayState(replayState);

  runInTransaction(database, () => {
    database.exec("DELETE FROM result_fragments");
    database.exec("DELETE FROM result_groups");
    database.exec("DELETE FROM visible_sequence_allocations");

    insertVisibleSequenceAllocations(database, replayState.visibleMessages);
    for (const resultGroup of replayState.resultGroups) {
      insertCommittedResultGroup(database, resultGroup);
    }
  });
}

function assertReplayState(replayState: SessionSidecarReplayState): void {
  const seenCanonicalIDs = new Set<string>();
  for (const visibleMessage of replayState.visibleMessages) {
    if (seenCanonicalIDs.has(visibleMessage.canonicalID)) {
      throw new Error(
        `Replay fixture canonical id '${visibleMessage.canonicalID}' was duplicated.`,
      );
    }

    seenCanonicalIDs.add(visibleMessage.canonicalID);
  }

  const seenMarkIDs = new Set<string>();
  for (const resultGroup of replayState.resultGroups) {
    if (seenMarkIDs.has(resultGroup.markID)) {
      throw new Error(
        `Replay fixture mark id '${resultGroup.markID}' was duplicated.`,
      );
    }

    seenMarkIDs.add(resultGroup.markID);

    if (resultGroup.fragments.length === 0) {
      throw new Error(
        `Replay fixture result group '${resultGroup.markID}' must contain at least one fragment.`,
      );
    }
  }
}
