# TypeScript SDK Developer Friction (Measured 2026-06-21)

## Scope and method

- Environment: Linux audit host.
- Timings measured with `/usr/bin/time -f 'elapsed=%e'`.
- Install paths measured:
  - local path install from monorepo package
  - networked npm registry install

## Time to first event

- Local path install:
  - `npm install /home/nyahcheck/go/src/github.com/atensec/maat/frontend/packages/thoth`: **0.68s**.
- Networked install:
  - Fresh temp project `npm install @atensec/thoth`: **2.04s**.
- Runtime regression proof:
  - `npm test -- --run src/__tests__/enforcer-client.test.ts src/__tests__/compatibility.runtime.test.ts`
    in package dir: **17 passed** in **1.95s** test runtime.

## Instrumentation lines required

- Typical setup is `instrument(tools, config)` with required IDs/scope/url.
- Practical first-governed-call code is **6-8 lines**.
- Result: does not consistently meet the "5 lines or fewer" target.

## Error clarity observed

- Enforcer fallback logging is explicit for fail-closed and fail-open paths.
- `failOpen` is available in config and via `THOTH_FAIL_OPEN`.

## If a developer is confused

- They may assume fail-open is default from older guidance.
- They may not know whether to set `failOpen` in code or env.

## Top 3 friction points likely to stall a pilot

1. Required config surface is still larger than two env vars for practical onboarding.
2. Initial success still depends on understanding governance identifiers/scope.
3. Signal actionability expectations are dashboard-dependent and not obvious from npm docs alone.
