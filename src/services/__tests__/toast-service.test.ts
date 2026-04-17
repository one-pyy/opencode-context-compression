import { test, expect, mock } from "bun:test";
import { ToastService } from "../toast-service.js";
import type { PluginInput } from "@opencode-ai/plugin";

function createMockInput(mockShowToast: ReturnType<typeof mock>): PluginInput {
  return {
    client: {
      tui: {
        showToast: mockShowToast,
      },
    },
  } as unknown as PluginInput;
}

test("showPluginStarted calls showToast with correct params", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showPluginStarted();

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "info",
      title: "Context Compression",
      message: "Plugin started and monitoring context usage",
      duration: 3000,
    },
  });
});

test("showSoftReminder calls showToast with correct params", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showSoftReminder(50000);

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "warning",
      title: "Context Usage Warning",
      message: "50,000 compressible tokens detected. Consider compressing context.",
      duration: 5000,
    },
  });
});

test("showHardReminder calls showToast with correct params", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showHardReminder(100000);

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "error",
      title: "Context Usage Critical",
      message: "100,000 compressible tokens! Compression strongly recommended.",
      duration: 7000,
    },
  });
});

test("showCompressionStarted calls showToast with correct params", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showCompressionStarted();

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "info",
      title: "Compression Started",
      message: "Context compression in progress...",
      duration: 3000,
    },
  });
});

test("showCompressionCompleted calls showToast with correct params (with savedTokens)", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showCompressionCompleted(25000);

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "success",
      title: "Compression Successful",
      message: "Compression complete! Saved 25,000 tokens.",
      duration: 4000,
    },
  });
});

test("showCompressionCompleted calls showToast with correct params (without savedTokens)", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showCompressionCompleted();

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "success",
      title: "Compression Successful",
      message: "Compression complete!",
      duration: 4000,
    },
  });
});

test("showCompressionFailed calls showToast with correct params (with error)", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showCompressionFailed("Network timeout");

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "error",
      title: "Compression Failed",
      message: "Compression failed: Network timeout",
      duration: 5000,
    },
  });
});

test("showCompressionFailed calls showToast with correct params (without error)", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  await service.showCompressionFailed();

  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "error",
      title: "Compression Failed",
      message: "Compression failed. Please try again.",
      duration: 5000,
    },
  });
});

// Deduplication tests
test("soft reminder deduplication blocks within 5 minutes", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  // First call should succeed
  await service.showSoftReminder(50000);
  expect(mockShowToast).toHaveBeenCalledTimes(1);

  // Second call immediately after should be blocked
  await service.showSoftReminder(60000);
  expect(mockShowToast).toHaveBeenCalledTimes(1); // Still 1, not 2
});

test("soft reminder deduplication allows after 5 minutes", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  // Mock Date.now to control time
  const originalDateNow = Date.now;
  let currentTime = 1000000;
  Date.now = () => currentTime;

  try {
    // First call
    await service.showSoftReminder(50000);
    expect(mockShowToast).toHaveBeenCalledTimes(1);

    // Advance time by 5 minutes (300000ms)
    currentTime += 300000;

    // Second call should succeed
    await service.showSoftReminder(60000);
    expect(mockShowToast).toHaveBeenCalledTimes(2);
  } finally {
    Date.now = originalDateNow;
  }
});

test("hard reminder deduplication blocks within 10 minutes", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  // First call should succeed
  await service.showHardReminder(100000);
  expect(mockShowToast).toHaveBeenCalledTimes(1);

  // Second call immediately after should be blocked
  await service.showHardReminder(120000);
  expect(mockShowToast).toHaveBeenCalledTimes(1); // Still 1, not 2
});

test("hard reminder deduplication allows after 10 minutes", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  // Mock Date.now to control time
  const originalDateNow = Date.now;
  let currentTime = 1000000;
  Date.now = () => currentTime;

  try {
    // First call
    await service.showHardReminder(100000);
    expect(mockShowToast).toHaveBeenCalledTimes(1);

    // Advance time by 10 minutes (600000ms)
    currentTime += 600000;

    // Second call should succeed
    await service.showHardReminder(120000);
    expect(mockShowToast).toHaveBeenCalledTimes(2);
  } finally {
    Date.now = originalDateNow;
  }
});

test("methods without cooldown always show (no deduplication)", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: true });

  // showPluginStarted has no cooldown
  await service.showPluginStarted();
  await service.showPluginStarted();
  await service.showPluginStarted();

  expect(mockShowToast).toHaveBeenCalledTimes(3);
});

// Configuration tests
test("disabled config prevents all toast calls", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, { enabled: false });

  await service.showPluginStarted();
  await service.showSoftReminder(50000);
  await service.showHardReminder(100000);
  await service.showCompressionStarted();
  await service.showCompressionCompleted(25000);
  await service.showCompressionFailed("error");

  expect(mockShowToast).toHaveBeenCalledTimes(0);
});

test("custom duration for startup toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { startup: 10000 },
  });

  await service.showPluginStarted();

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "info",
      title: "Context Compression",
      message: "Plugin started and monitoring context usage",
      duration: 10000,
    },
  });
});

test("custom duration for soft reminder toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { softReminder: 8000 },
  });

  await service.showSoftReminder(50000);

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "warning",
      title: "Context Usage Warning",
      message: "50,000 compressible tokens detected. Consider compressing context.",
      duration: 8000,
    },
  });
});

test("custom duration for hard reminder toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { hardReminder: 12000 },
  });

  await service.showHardReminder(100000);

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "error",
      title: "Context Usage Critical",
      message: "100,000 compressible tokens! Compression strongly recommended.",
      duration: 12000,
    },
  });
});

test("custom duration for compression start toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { compressionStart: 6000 },
  });

  await service.showCompressionStarted();

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "info",
      title: "Compression Started",
      message: "Context compression in progress...",
      duration: 6000,
    },
  });
});

test("custom duration for compression complete toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { compressionComplete: 9000 },
  });

  await service.showCompressionCompleted(25000);

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "success",
      title: "Compression Successful",
      message: "Compression complete! Saved 25,000 tokens.",
      duration: 9000,
    },
  });
});

test("custom duration for compression failed toast", async () => {
  const mockShowToast = mock(() => Promise.resolve());
  const mockInput = createMockInput(mockShowToast);
  const service = new ToastService(mockInput, {
    enabled: true,
    durations: { compressionFailed: 15000 },
  });

  await service.showCompressionFailed("error");

  expect(mockShowToast).toHaveBeenCalledWith({
    body: {
      variant: "error",
      title: "Compression Failed",
      message: "Compression failed: error",
      duration: 15000,
    },
  });
});
