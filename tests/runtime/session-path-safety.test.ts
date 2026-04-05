import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireSessionFileLock,
  resolvePluginLockDirectory,
  resolveSessionFileLockPath,
} from "../../src/runtime/file-lock.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "../../src/state/session-db.js";

test("session database and lock paths stay under plugin-owned directories for a normal session ID", async () => {
  const pluginDirectory = "/tmp/opencode-context-compression-plugin";
  const sessionID = "session-123";

  assert.equal(
    resolveSessionDatabasePath(pluginDirectory, sessionID),
    `${resolvePluginStateDirectory(pluginDirectory)}/session-123.db`,
  );
  assert.equal(
    resolveSessionFileLockPath(resolvePluginLockDirectory(pluginDirectory), sessionID),
    `${resolvePluginLockDirectory(pluginDirectory)}/session-123.lock`,
  );
});

test("session filesystem path builders reject traversal, embedded separators, and absolute paths", async () => {
  const pluginDirectory = "/tmp/opencode-context-compression-plugin";
  const lockDirectory = resolvePluginLockDirectory(pluginDirectory);

  for (const sessionID of [
    "../escape",
    "nested/session",
    "nested\\session",
    "/absolute/path",
    "C:\\absolute\\path",
  ]) {
    assert.throws(
      () => resolveSessionDatabasePath(pluginDirectory, sessionID),
      /Session ID/u,
      `expected database path resolution to reject '${sessionID}'`,
    );
    assert.throws(
      () => resolveSessionFileLockPath(lockDirectory, sessionID),
      /Session ID/u,
      `expected lock path resolution to reject '${sessionID}'`,
    );
    await assert.rejects(
      () =>
        acquireSessionFileLock({
          lockDirectory,
          sessionID,
        }),
      /Session ID/u,
      `expected lock acquisition to reject '${sessionID}'`,
    );
  }
});
