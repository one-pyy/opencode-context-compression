# Toast Integration Execution Plan

## Project Overview
Integrate Toast notification system into opencode-context-compression plugin for user-visible lifecycle events.

## TODOs

### M1: Basic Infrastructure

- [x] **T1**: Create Toast service infrastructure (`src/services/toast-service.ts`)
  - Implement ToastService class with methods: showPluginStarted, showSoftReminder, showHardReminder, showCompressionStarted, showCompressionCompleted, showCompressionFailed
  - Add deduplication logic with Map<string, number> for tracking last shown timestamps
  - Add configuration support for enabling/disabling toasts
  - **Parallelizable**: Independent
  - **Files**: `src/services/toast-service.ts` (new)

- [x] **T2**: Add toast configuration to plugin config schema
  - Extend config schema with toast settings (enabled, durations per event type)
  - Update config types
  - Add default values
  - **Parallelizable**: Independent
  - **Files**: `src/config/schema.ts`, `src/types/config.ts`

- [x] **T3**: Integrate toast service into plugin lifecycle (startup notification)
  - Initialize ToastService in plugin entry point
  - Add startup toast when plugin initializes
  - Handle errors gracefully with .catch(() => {})
  - **Parallelizable**: Depends on T1, T2
  - **Files**: `src/index.ts` or `src/runtime/plugin-hooks.ts`

### M2: Reminder Notifications

- [x] **T4**: Add soft reminder toast notification
  - Hook into soft reminder trigger point
  - Call ToastService.showSoftReminder with token count
  - Apply deduplication (5 min cooldown)
  - **Parallelizable**: Depends on T1
  - **Files**: Reminder trigger location (TBD after exploration)

- [x] **T5**: Add hard reminder toast notification
  - Hook into hard reminder trigger point
  - Call ToastService.showHardReminder with token count
  - Apply deduplication (10 min cooldown)
  - **Parallelizable**: Depends on T1
  - **Files**: Reminder trigger location (TBD after exploration)

### M3: Compression Lifecycle

- [x] **T6**: Add compression start toast notification
  - Hook into compression start event
  - Call ToastService.showCompressionStarted
  - **Parallelizable**: Depends on T1
  - **Files**: Compression orchestrator (TBD after exploration)

- [x] **T7**: Implement token counter utility
  - Create TokenCounter class for calculating compression ratio
  - Add methods: countTokens, calculateCompressionRatio
  - Use tiktoken or simple estimation
  - **Parallelizable**: Independent
  - **Files**: `src/utils/token-counter.ts` (new)

- [x] **T8**: Add compression completion toast with compression ratio
  - Hook into compression completion event
  - Calculate compression ratio using TokenCounter
  - Call ToastService.showCompressionCompleted with ratio
  - **Parallelizable**: Depends on T1, T7
  - **Files**: Compression orchestrator (TBD after exploration)

- [x] **T9**: Add compression failure toast notification
  - Hook into compression error handling
  - Call ToastService.showCompressionFailed with error message
  - **Parallelizable**: Depends on T1
  - **Files**: Compression orchestrator (TBD after exploration)

### M4: Testing & Documentation

- [x] **T10**: Write unit tests for ToastService
  - Test deduplication logic
  - Test configuration handling
  - Test all toast methods
  - **Parallelizable**: Depends on T1
  - **Files**: `src/services/__tests__/toast-service.test.ts` (new)

- [x] **T11**: Write unit tests for TokenCounter
  - Test token counting
  - Test compression ratio calculation
  - **Parallelizable**: Depends on T7
  - **Files**: `src/utils/__tests__/token-counter.test.ts` (new)

- [x] **T12**: Update documentation
  - Document toast configuration options
  - Add usage examples
  - Update README if needed
  - **Parallelizable**: Independent
  - **Files**: `docs/toast-notifications.md` (new), `README.md`

- [ ] **T13**: Manual integration testing
  - Test all toast notifications in real plugin environment
  - Verify deduplication works
  - Verify configuration toggles work
  - **Parallelizable**: Depends on all implementation tasks
  - **Files**: N/A (manual testing)

## Final Verification Wave

- [x] **F1**: Code Quality Review - Verify code follows project patterns, has proper error handling, and meets quality standards

- [x] **F2**: Type Safety Review - Verify TypeScript types are correct, no type errors, proper type definitions

- [x] **F3**: Test Coverage Review - Verify all critical paths have tests, tests pass, edge cases covered

- [x] **F4**: Integration Review - Verify toast notifications work end-to-end, configuration works, no regressions

## Parallelization Map

**Group 1 (Parallel)**: T1, T2, T7
**Group 2 (Parallel, after T1+T2)**: T3
**Group 3 (Parallel, after T1)**: T4, T5, T6, T9
**Group 4 (Parallel, after T1+T7)**: T8
**Group 5 (Parallel, after T1+T7)**: T10, T11
**Group 6 (After all implementation)**: T12, T13
**Final Wave (After all tasks)**: F1, F2, F3, F4

## Notes

- Toast API uses `api.ui.toast()` for TUI plugins or `ctx.client.tui.showToast()` for server plugins
- All toast calls must have `.catch(() => {})` to prevent failures from breaking plugin logic
- Deduplication prevents spam: soft reminder (5 min), hard reminder (10 min)
- Token counting can use simple estimation (chars/4) or tiktoken library
- Configuration should allow users to disable toasts if desired
