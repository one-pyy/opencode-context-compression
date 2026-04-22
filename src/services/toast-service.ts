import type { PluginInput } from "@opencode-ai/plugin";

export interface ToastConfig {
  enabled: boolean;
  durations?: {
    startup?: number;
    softReminder?: number;
    hardReminder?: number;
    compressionStart?: number;
    compressionComplete?: number;
    compressionFailed?: number;
  };
}

type ToastEventType =
  | "startup"
  | "softReminder"
  | "hardReminder"
  | "compressionStart"
  | "compressionComplete"
  | "compressionFailed";

export class ToastService {
  private readonly input: PluginInput;
  private readonly config: ToastConfig;
  private readonly lastShownTimestamps: Map<ToastEventType, number> = new Map();

  // Cooldown periods in milliseconds
  private readonly SOFT_REMINDER_COOLDOWN = 300000; // 5 minutes
  private readonly HARD_REMINDER_COOLDOWN = 600000; // 10 minutes

  constructor(input: PluginInput, config: ToastConfig = { enabled: true }) {
    this.input = input;
    this.config = config;
  }

  private shouldShowToast(eventType: ToastEventType, cooldownMs?: number): boolean {
    if (!this.config.enabled) {
      return false;
    }

    if (cooldownMs === undefined) {
      return true; // No cooldown, always show
    }

    const lastShown = this.lastShownTimestamps.get(eventType);
    if (lastShown === undefined) {
      return true; // Never shown before
    }

    const now = Date.now();
    return now - lastShown >= cooldownMs;
  }

  private recordToastShown(eventType: ToastEventType): void {
    this.lastShownTimestamps.set(eventType, Date.now());
  }

  private async showToast(
    variant: "info" | "success" | "warning" | "error",
    title: string,
    message: string,
    duration?: number,
  ): Promise<boolean> {
    try {
      await this.input.client.tui.showToast({
        body: {
          variant,
          title,
          message,
          duration,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async showPluginStarted(): Promise<boolean> {
    if (!this.shouldShowToast("startup")) {
      return false;
    }

    const shown = await this.showToast(
      "info",
      "Context Compression",
      "Plugin started and monitoring context usage",
      this.config.durations?.startup ?? 3000,
    );

    if (shown) {
      this.recordToastShown("startup");
    }

    return shown;
  }

  async showSoftReminder(compressibleTokens: number): Promise<void> {
    if (!this.shouldShowToast("softReminder", this.SOFT_REMINDER_COOLDOWN)) {
      return;
    }

    await this.showToast(
      "warning",
      "Context Usage Warning",
      `${compressibleTokens.toLocaleString()} compressible tokens detected. Consider compressing context.`,
      this.config.durations?.softReminder ?? 5000,
    );

    this.recordToastShown("softReminder");
  }

  async showHardReminder(compressibleTokens: number): Promise<void> {
    if (!this.shouldShowToast("hardReminder", this.HARD_REMINDER_COOLDOWN)) {
      return;
    }

    await this.showToast(
      "error",
      "Context Usage Critical",
      `${compressibleTokens.toLocaleString()} compressible tokens! Compression strongly recommended.`,
      this.config.durations?.hardReminder ?? 7000,
    );

    this.recordToastShown("hardReminder");
  }

  async showCompressionStarted(): Promise<void> {
    if (!this.shouldShowToast("compressionStart")) {
      return;
    }

    await this.showToast(
      "info",
      "Compression Started",
      "Context compression in progress...",
      this.config.durations?.compressionStart ?? 3000,
    );

    this.recordToastShown("compressionStart");
  }

  async showCompressionCompleted(savedTokens?: number): Promise<void> {
    if (!this.shouldShowToast("compressionComplete")) {
      return;
    }

    const message =
      savedTokens !== undefined
        ? `Compression complete! Saved ${savedTokens.toLocaleString()} tokens.`
        : "Compression complete!";

    await this.showToast(
      "success",
      "Compression Successful",
      message,
      this.config.durations?.compressionComplete ?? 4000,
    );

    this.recordToastShown("compressionComplete");
  }

  async showCompressionFailed(error?: string): Promise<void> {
    if (!this.shouldShowToast("compressionFailed")) {
      return;
    }

    const message = error
      ? `Compression failed: ${error}`
      : "Compression failed. Please try again.";

    await this.showToast(
      "error",
      "Compression Failed",
      message,
      this.config.durations?.compressionFailed ?? 5000,
    );

    this.recordToastShown("compressionFailed");
  }
}
