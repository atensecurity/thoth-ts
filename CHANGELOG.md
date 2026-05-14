# Changelog

All notable changes to `@atensec/thoth` are documented in this file.

## 0.1.18 - 2026-05-14

### Changed

- Added SDK handling for `MODIFY` and `DEFER` decision types:
  - `MODIFY` allows the enforcer to rewrite tool arguments before execution.
  - `DEFER` raises `ThothPolicyViolation` with `deferTimeout` context so callers can retry later.
- Expanded enforcement decision aliases: `DENY→BLOCK`, `CHALLENGE/ESCALATE→STEP_UP`, `TRANSFORM→MODIFY`, `HOLD→DEFER`.
- `EnforcementMode.OBSERVE` is the canonical shadow-mode value; `EnforcementMode.SHADOW` removed.
- Added expanded `ThothPolicyViolation` metadata fields for downstream logging and incident handling:
  `decisionReason`, `modelFeatures`, `modelSignals`, `packVersion`, `ruleVersion`, `signedReceiptPayload`.
- Added expanded policy context propagation: `toolArgs`, `environment`, `enforcementTraceId`,
  `sessionIntent`, `purpose`, `dataClassification`, `taskContext`.
- Improved HTTP diagnostics for auth/ingress failures with actionable hints for 401/403 responses.
- Removed legacy `0.5.x` package versions from npm registry.

## 0.1.17 - 2026-05-10

### Changed

- Corrected the public TypeScript SDK release line to `0.1.17`.
- Updated release metadata/changelog for the `sdk/npm/v0.1.17` tag line.

## 0.5.10 - 2026-05-05

### Changed

- Declared the current stable TypeScript SDK release line in a versioned changelog.
- Added customer-facing release-note structure for future tagged releases.
