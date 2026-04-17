# Toast Integration Decisions

## Build Configuration Fix
**Date**: 2026-04-17
**Decision**: Exclude test files from production build by adding `"exclude": ["src/**/__tests__/**"]` to `tsconfig.build.json`

**Rationale**: 
- Test files using `bun:test` were causing TypeScript compilation errors in the build process
- Tests should not be included in the production build output
- The build process should only compile source files, not test files

**Impact**: Build now succeeds without errors. Tests still run correctly via `bun test`.
