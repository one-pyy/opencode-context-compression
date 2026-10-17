import type { CompressionInspectEntry } from "../tools/compression-inspect.js";

export function renderCompressionInspectTable(
  entries: readonly CompressionInspectEntry[],
  mode: "compact" | "delete",
): string {
  const visible = entries.filter((entry) => entry.kind !== "user");
  const rows = visible.map((entry) => {
    if (entry.kind === "fragment") {
      return ["referable", entry.from, entry.to, entry.tokens].join("\t");
    }
    return ["compressible", entry.from, entry.to, entry.tokens].join("\t");
  });
  return [
    `模式\t${mode}`,
    `总计\t${visible.reduce((sum, entry) => sum + entry.tokens, 0)}`,
    "类型\t起点\t终点\ttoken数",
    ...rows,
  ].join("\n");
}
