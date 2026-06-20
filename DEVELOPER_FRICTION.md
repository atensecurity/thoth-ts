# TypeScript SDK Developer Friction (Measured 2026-06-19)

## Scope and method
- Environment: Linux sandbox.
- Install simulation: fresh temp project, `npm install /path/to/frontend/packages/thoth`.

## Time to first event
- Local install: **0.75s wall time**.
- Targeted governance regression run: `vitest` for enforcer client completed in **0.53s**.
- External npm registry install (`npm install @atensec/thoth`) was not measured in this sandbox.

## Instrumentation lines required
- Typical setup is `instrument(tools, config)` with required IDs/scope/url.
- Practical first-governed-call code is **6-8 lines**.
- Result: does not yet meet the "5 lines or fewer" pilot target consistently.

## Error clarity observed
- Enforcer fallback logging is explicit for fail-closed and fail-open paths.
- New `failOpen` switch is available in config and via `THOTH_FAIL_OPEN`.

## If a developer is confused
- They may assume fail-open is default because older docs historically implied permissive fallback.
- They may not know whether to set `failOpen` in code or environment.

## Top 3 friction points likely to stall a pilot
1. Required config surface is still larger than two env vars for practical onboarding.
2. No enforced compatibility matrix test suite for Datadog/LangSmith/Otel/Sentry concurrency.
3. Event/actionability expectations depend on dashboard context that is outside npm package docs.
