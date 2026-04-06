export class InvalidCompactionOutputError extends Error {
  readonly markId: string;
  readonly model: string;
  readonly executionMode: "compact" | "delete";

  constructor(options: {
    readonly markId: string;
    readonly model: string;
    readonly executionMode: "compact" | "delete";
    readonly detail: string;
  }) {
    super(
      `Invalid compaction output for mark '${options.markId}' on model '${options.model}' (${options.executionMode}): ${options.detail}`,
    );
    this.name = "InvalidCompactionOutputError";
    this.markId = options.markId;
    this.model = options.model;
    this.executionMode = options.executionMode;
  }
}
