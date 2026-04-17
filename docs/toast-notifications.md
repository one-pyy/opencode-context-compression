# Toast Notifications

## Overview

The context compression plugin includes a toast notification system that provides visual feedback for key events during compression operations. Toast notifications appear briefly in the OpenCode UI to inform users about plugin activity without interrupting their workflow.

## Configuration

Toast notifications can be configured through the `runtime-config.jsonc` file or environment variables.

### Options

The toast configuration supports the following options:

- `enabled` (boolean): Master switch to enable or disable all toast notifications
- `durations` (object): Event-specific display durations in milliseconds

### Default Values

```jsonc
{
  "toast": {
    "enabled": true,
    "durations": {
      "startup": 3000,
      "softReminder": 5000,
      "hardReminder": 7000,
      "compressionStart": 3000,
      "compressionComplete": 4000,
      "compressionFailed": 5000
    }
  }
}
```

### Example Configuration

**Using runtime-config.jsonc:**

```jsonc
{
  "toast": {
    "enabled": true,
    "durations": {
      "startup": 2000,
      "softReminder": 4000,
      "hardReminder": 6000,
      "compressionStart": 2500,
      "compressionComplete": 3500,
      "compressionFailed": 6000
    }
  }
}
```

**Using environment variables:**

```bash
export OPENCODE_CONTEXT_COMPRESSION_TOAST_ENABLED=true
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_STARTUP=2000
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_SOFT_REMINDER=4000
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_HARD_REMINDER=6000
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_COMPRESSION_START=2500
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_COMPRESSION_COMPLETE=3500
export OPENCODE_CONTEXT_COMPRESSION_TOAST_DURATION_COMPRESSION_FAILED=6000
```

**Disabling toast notifications:**

```jsonc
{
  "toast": {
    "enabled": false
  }
}
```

Or via environment variable:

```bash
export OPENCODE_CONTEXT_COMPRESSION_TOAST_ENABLED=false
```

## Toast Events

The plugin displays toast notifications for the following events:

1. **Startup** (`startup`)
   - Displayed when the plugin initializes successfully
   - Confirms the context compression plugin is active
   - Default duration: 3000ms

2. **Soft Reminder** (`softReminder`)
   - Gentle reminder that context compression is available
   - Triggered when context size reaches soft threshold
   - Default duration: 5000ms

3. **Hard Reminder** (`hardReminder`)
   - Urgent reminder that compression is recommended
   - Triggered when context size reaches hard threshold
   - Default duration: 7000ms

4. **Compression Start** (`compressionStart`)
   - Indicates compression operation has begun
   - Provides immediate feedback when compression triggers
   - Default duration: 3000ms

5. **Compression Complete** (`compressionComplete`)
   - Confirms successful compression with token savings
   - Shows before/after token counts
   - Default duration: 4000ms

6. **Compression Failed** (`compressionFailed`)
   - Alerts user to compression errors
   - Includes error details for troubleshooting
   - Default duration: 5000ms

## Deduplication

To prevent notification spam, the toast system includes automatic deduplication with cooldown periods:

- **Soft Reminder**: 5-minute cooldown between notifications
- **Hard Reminder**: 10-minute cooldown between notifications

Other events (startup, compression start/complete/failed) are not deduplicated as they represent discrete, non-repetitive actions.

## Implementation Details

The toast notification system is implemented through the `ToastNotificationService` class, which integrates with OpenCode's native toast API. The service:

- Validates configuration on initialization
- Respects the global `enabled` flag
- Applies event-specific durations
- Enforces deduplication rules automatically
- Handles errors gracefully (falls back to defaults)

For technical implementation details, see the source code at `src/services/toast-notification-service.ts`.
