import type { PluginInput } from "@opencode-ai/plugin";
import { openSessionSidecarRepository } from "../state/sidecar-store.js";
import type { CompressionStatsSnapshot } from "./compression-stats.js";

const STATE_KEY = "cpmark_reminder_armed";
const REARM_DELTA = 30_000;
export const CPMARK_REMINDER_TEXT = "别忘了cpmark，这次不用调用inspect，用之前的就好。cpmark完继续之前的任务。如果之前的任务已结束，同样结束。";

// 调用方使用统计调度器按会话串行执行，避免同一会话并发发送。
export async function sendCpmarkReminder(input: {
  readonly stats: CompressionStatsSnapshot;
  readonly threshold: number;
  readonly databasePath: string;
  readonly pluginInput: PluginInput;
}): Promise<void> {
  const { stats } = input;
  const sidecar = await openSessionSidecarRepository({
    databasePath: input.databasePath,
  });
  try {
    const stored = sidecar.database.prepare<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = :key",
    ).get({ key: STATE_KEY });
    const armed = stored?.value !== "0";
    const total = stats.deletableTokenCount + stats.compressibleTokenCount;
    const upper = input.threshold + stats.protectedTokenCount;
    let nextArmed: boolean;
    if (!armed && total <= upper - REARM_DELTA) {
      nextArmed = true;
    } else if (armed && total > upper) {
      await input.pluginInput.client.session.prompt({
        path: { id: stats.sessionID },
        query: { directory: input.pluginInput.directory },
        body: {
          noReply: true,
          parts: [{ type: "text", text: CPMARK_REMINDER_TEXT }],
        },
        throwOnError: true,
      });
      nextArmed = false;
    } else {
      return;
    }
    sidecar.database.prepare(`
      INSERT INTO schema_meta (key, value) VALUES (:key, :value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ key: STATE_KEY, value: nextArmed ? "1" : "0" });
  } finally {
    sidecar.close();
  }
}
