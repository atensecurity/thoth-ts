# Changelog

All notable changes to `@atensec/thoth` are documented in this file.

## 0.1.19 - 2026-06-20

### Changed

- Added configurable resilience mode via `failOpen` / `THOTH_FAIL_OPEN`.
  When enabled, enforcer transport failures and retryable statuses (`429`, `5xx`)
  return `ALLOW` so tool execution can continue.
- Auth failures (`401`/`403`) remain fail-closed and continue returning `BLOCK`.
- Added regression tests for fail-open timeout/status behavior and auth-failure handling.
- Added vendor-runtime compatibility regression tests for Datadog, LangSmith,
  OpenTelemetry, and Sentry coexistence with Thoth tool interception.
- Added compatibility matrix CI coverage with per-stack TypeScript runtime test runs.

## 0.1.18 - 2026-05-14

### Changed

- Added SDK handling for `MODIFY` and `DEFER` decision types:
  - `MODIFY` allows the enforcer to rewrite tool arguments before execution.
  - `DEFER` raises `ThothPolicyViolation` with `deferTimeoutSeconds` context so callers can retry later.
- Expanded enforcement decision aliases: `DENY→BLOCK`, `CHALLENGE/ESCALATE→STEP_UP`, `TRANSFORM→MODIFY`, `HOLD→DEFER`.
- `EnforcementMode.OBSERVE` is the canonical shadow-mode value; `EnforcementMode.SHADOW` removed.
- Added `decisionEnvelopeVersion`, `enforcementTraceId`, `fastmlFeatures`, `scoreComponents`,
  `topContributors`, and `decisionEvidence` to `EnforcementDecision` and `ThothPolicyViolation`
  for full parity with Python SDK v0.1.16 decision envelope schema.
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
