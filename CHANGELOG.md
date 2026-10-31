# Changelog

All notable changes to `@atensec/thoth` are documented in this file.

## Unreleased

### Fixed

- `actingFor(userId, fn, { sessionId })`: Thoth now sees a session ID derived
  from the tenant, agent, user and your session ID, rather than your ID
  itself, so two users who name the same session never share one in Thoth.
  The ID is stable across processes, and the Python SDK derives the same ID.
- README: the LangChain.js example passed an `AgentExecutor` to `instrument()`,
  which wraps tools with a `.run` method. LangChain.js tools have none, so no
  tool in that example was governed. The section now uses
  `governLangChainTools`.

### Added

- `actingFor(userId, fn, { sessionId })` now covers every governed tool given
  no `userId`, including those governed with `instrument()` or a `govern*`
  function (the AI SDK, OpenAI Agents, Mastra, Genkit, the Claude Agent SDK
  and the rest), and no longer needs `init()`. Govern the tools once at
  startup and each call in a block is checked as that user. Every governed
  tool of the same agent in a block shares one session, and a named session
  continues across requests even when the tools are governed anew per
  request. A `userId` set in a tool's config still wins.
- `init()` now also governs Strands Agents and Google ADK. For Strands, every
  agent-loop tool call and every direct `agent.tool.<name>()` call is checked
  with exactly the input that runs; a streaming tool runs inside the check
  and its events still stream as they come, and a refused call ends with an
  error tool result, "Thoth refused this call: <reason>". For ADK, each tool
  an `LlmAgent` uses is governed as the agent resolves its tools, so your own
  `BaseTool` subclasses are governed too; a refused call throws
  `ThothPolicyViolation` from `runAsync`. Tested with `@strands-agents/sdk` 1.23.0
  and `@google/adk` 2.4.0.
- `init()` and `actingFor()`: one call at startup governs every LangChain.js
  and LangGraph.js tool and every MCP client call (`@modelcontextprotocol/sdk`)
  in the process, including tools and clients created before it, with no
  tools wrapped. `actingFor(userId, fn, { sessionId })` runs a request for the
  user it serves, in its own session or a named one shared by that user's
  blocks. An MCP call that a governed LangChain tool already checked (the same
  arguments, under the MCP tool's name or a prefixed form of it) isn't checked
  twice. `init()` reads `THOTH_AGENT_ID` and `THOTH_TENANT_ID` with the
  existing variables; `shutdown()` removes it. Frameworks whose tools are plain
  objects keep their `govern*` functions. Tested with `@langchain/core` 1.3.2
  and `@modelcontextprotocol/sdk` 1.32.2.
- Cloudflare Agents: documented governing a chat agent's tools with
  `governAiSdkTools`, since `AIChatAgent` (`@cloudflare/ai-chat`) runs tools
  through the AI SDK and `this.mcp.getAITools()` returns MCP tools as an AI SDK
  tool set. Tested with a tool set in that shape.
- LangChain.js and LangGraph.js: `governLangChainTools(tools, config)` (also
  `@atensec/thoth/langchain`) returns governed copies of LangChain tools for
  LangGraph's `ToolNode` and `createReactAgent` and for LangChain agents. Each
  `invoke` (and `call`) is checked with the tool's arguments, a `ToolCall` by
  its `args`; a refused call never runs. The tools passed in are unchanged.
  Tested with `@langchain/core` 1.3.2 and `@langchain/langgraph` 1.6.0.
- Mastra: `governMastraTools(tools, config)` (also `@atensec/thoth/mastra`)
  returns governed copies of a Mastra agent's tools, keyed the same. Each
  `execute` is checked with the tool's input, Mastra's execution context passes
  through unchanged, and a refused call never runs. Copies keep each tool's
  fields and class; the tools passed in are unchanged. Tested with a Mastra
  `Agent` from `@mastra/core` 1.81.0.
- OpenAI Agents SDK: `governOpenAIAgentTools(tools, config)` (also
  `@atensec/thoth/openai-agents`) governs an agent's function tools. Each call
  is checked with the model's arguments before the tool runs, and the tool runs
  with exactly the arguments Thoth checked; arguments that aren't a JSON object
  are refused. A refused call never runs, and the model gets "Thoth refused
  this call: <reason>" as the tool's output. Hosted tools are left as they
  are; local tools Thoth can't check (shell, apply_patch, computer) make it
  throw unless named in `options.ungoverned`. Tested with `@openai/agents`
  0.21.0's `run()`.
- Strands Agents: `governStrandsTools(tools, config)` (also
  `@atensec/thoth/strands`) returns governed copies of a Strands agent's
  tools. Each call is checked with its final input when the tool runs, and the
  tool runs with exactly the input Thoth checked, so a later hook can't change
  it after the check; a refused call never runs. Tested with a Strands `Agent`
  from `@strands-agents/sdk` 1.23.0.
- Google ADK: `governAdkTools(tools, config)` (also
  `@atensec/thoth/google-adk`) returns governed copies of an ADK agent's
  tools. Each call is checked with its final arguments when the tool's
  `runAsync` runs, and the tool runs with exactly the arguments Thoth checked,
  so a `beforeToolCallback` can't change them after the check; a refused call
  never runs. Tested with an `LlmAgent` and `InMemoryRunner` from
  `@google/adk` 2.4.0.
- Genkit: `thothGenkitMiddleware(generateMiddleware, config)` (also
  `@atensec/thoth/genkit`) builds Genkit generate middleware whose `tool` hook
  checks every tool call before it runs and runs the tool with exactly the
  input Thoth checked. Pass it last in `use` (`use: [thoth()]`), so no other
  middleware can change the input after the check. A refused call never runs,
  and the model gets "Thoth refused this call: <reason>" as the tool's output.
  Tested with `genkit` 1.43.0's `generate`.

- Claude Agent SDK: `governClaudeAgentOptions(options, config)` (also
  `@atensec/thoth/claude-agent-sdk`) adds Thoth as PreToolUse, PostToolUse
  and PostToolUseFailure hooks, so every tool call is checked before it runs,
  including tools in `allowedTools`. An allowed call is left to the SDK's own
  permission rules; a refused call, or one Thoth can't check, is denied with
  the reason; a held call waits up to 16 minutes. Tested with
  `@anthropic-ai/claude-agent-sdk` 0.3.316's hook types.

- MCP clients: `governMcpClient(client, config)` (also `@atensec/thoth/mcp`)
  governs every `callTool` an `@modelcontextprotocol/sdk` client makes, from
  your code or a framework's MCP adapter. Tools are governed by name as they
  are first called, in one session; a refused call never reaches the MCP
  server; listed tools are reported to the tool inventory. A call a governed
  wrapper already checked is not checked again. Tested with
  `@modelcontextprotocol/sdk` 1.32.2.

- Vercel AI SDK: `governAiSdkTools(tools, config)` (also
  `@atensec/thoth/ai-sdk`) governs a tool set for `generateText`,
  `streamText` or an `Agent`. Each tool with an `execute` is checked before it
  runs, with only the tool's input sent as its arguments; the call options
  reach `execute` unchanged, and tools without `execute` are left alone. Input
  schemas (Zod or JSON Schema) are reported to the tool inventory as JSON
  Schema. Tested with AI SDK 7.0.159.

## 0.1.22 - 2026-10-18

### Added

- Tool inventory: on instrumentation, the SDK sends each tool's name,
  description and input-schema structure to your Thoth API in the background,
  so Thoth can propose an effect class for an admin to confirm. Proposals are
  advisory: they never grant execution, and only an admin's confirmation
  changes decisions. Collection runs off the startup path, cannot raise into
  your code, and times out after 2 seconds.

### Privacy

- Schema `default`, `example`, `examples`, `const` and `enum` values are
  removed recursively before sending; parameters with those names are kept.
  Descriptions are sent as written, so keep secrets out of tool metadata.
- Set `THOTH_TOOL_INVENTORY=off` to disable collection. In runtimes without
  `process`, such as browsers and edge runtimes, collection stays on.

## 0.1.21 - 2026-09-11

### Fixed

- Continue polling canonical unresolved STEP_UP hold responses until resolution
  or the configured deadline instead of treating a missing decision field as a
  terminal fallback block. Timeout and malformed-response handling remain
  fail-closed.

## 0.1.20 - 2026-09-11

### Added

- Added a per-action attestation ID, generated for each tool call unless the
  caller supplies one, and propagated it through authorization, lifecycle
  telemetry, decisions, and policy errors.
- Added bounded human-explanation requests for blocked and step-up decisions and
  exposed the explanation on decisions and `ThothPolicyViolation`.
- Exported behavioral-event emission and per-event delivery status types for
  applications that need process-local telemetry health signals.

### Changed

- Minimize default telemetry with an explicit field allowlist; omit tool arguments and free-text context, reasons, explanations and full receipts. Authorization inputs and enforcement behavior are unchanged. See PRIVACY.md for wire data and migration limits.
- Remove payload-bearing diagnostic logs and verify the installed npm artifact against a local HTTP collector.
- Make telemetry delivery resilient: bounded retries with stable event IDs, so a
  retried delivery is de-duplicable server-side and never replays a governed tool
  call or re-requests authorization.
- Use native Node ESM imports throughout the published package.
- Restrict the published package to built output, source and user-facing docs via
  an explicit `files` allowlist. Development-only files (tests, CI workflows,
  `tsconfig.json`, fixtures and internal notes) are no longer published, and a
  packing artifact can no longer be swept into the tarball.

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
