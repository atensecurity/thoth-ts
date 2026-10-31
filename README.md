# @atensec/thoth

AI agent governance SDK for JavaScript/TypeScript by [Aten Security](https://atensecurity.com).

Thoth instruments your AI agents for governance, policy enforcement, and behavioral monitoring.
Every tool call is evaluated against your organization's security policies — blocking, stepping up
for human approval, or silently observing based on your configured enforcement mode.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Legacy ThothClient](#legacy-thothclient)
4. [How It Works](#how-it-works)
5. [LangChain.js and LangGraph.js](#langchainjs-and-langgraphjs)
6. [Framework Integrations](#framework-integrations)
   - [Anthropic Claude](#anthropic-claude)
   - [OpenAI Function Calling](#openai-function-calling)
7. [Configuration Reference](#configuration-reference)
8. [Error Handling](#error-handling)
9. [Environment Variables](#environment-variables)
10. [Enforcement Modes](#enforcement-modes)
11. [Policy Decisions](#policy-decisions)
12. [Dashboard](#dashboard)

---

## Installation

```bash
npm install @atensec/thoth
```

```bash
pnpm add @atensec/thoth
```

```bash
yarn add @atensec/thoth
```

**Requirements:** Node.js 22+, TypeScript 5.x (if using types)

**Tested runtimes:** Node.js 22, 24, and 26

---

## Quick Start

**1. Get your API key** from your Thoth dashboard at `https://<tenant>.<apex-domain>` under
**Settings → API Keys**.

**2. Set environment variables:**

```bash
export THOTH_API_KEY="thoth_live_..."
export THOTH_API_URL="https://enforce.<tenant>.<apex-domain>"
export THOTH_LOG_LEVEL="DEBUG" # optional; falls back to LOG_LEVEL when unset
```

**3. Instrument your agent:**

```typescript
import { instrument } from "@atensec/thoth";

// Instrument your agent — returns the same object, mutated in-place
const governed = instrument(agent, {
  agentId: "document-summarizer",
  approvedScope: ["web_search", "read_file", "send_email"],
  tenantId: "your-tenant-id",
  apiUrl: process.env.THOTH_API_URL!, // required if THOTH_API_URL is not set
  userId: "alice@example.com",
  enforcement: "block", // default is "block"; options: observe | step_up | block | progressive
  // apiKey reads from THOTH_API_KEY env var automatically
});

// Every tool call is now governed — no other changes required
const result = await governed.run(
  "Summarize the attached document and send it to the team.",
);
```

---

## Legacy ThothClient

Module-level APIs are preferred for new integrations:

- `instrument()`
- `wrapAnthropicTools()`
- `wrapOpenAITools()`

`ThothClient` remains supported for backward compatibility:

```typescript
import { ThothClient } from "@atensec/thoth";

const client = new ThothClient({
  tenantId: "your-tenant-id",
  userId: "alice@example.com",
});

client.instrument(agent, {
  agentId: "document-summarizer",
  approvedScope: ["web_search", "read_file"],
  apiUrl: process.env.THOTH_API_URL!,
});

// Legacy aliases:
client.wrap(agent, {
  agentId: "document-summarizer",
  approvedScope: ["web_search", "read_file"],
  apiUrl: process.env.THOTH_API_URL!,
});
```

---

## How It Works

```
Agent calls tool
      │
      ▼
Thoth intercepts (instrument)
      │
      ├── Emits TOOL_CALL_PRE event → tenant API (async, non-blocking)
      │
      ├── Calls enforcer /v1/enforce
      │        │
      │        ├── ALLOW   → tool executes normally
      │        ├── STEP_UP → waits for human approval (polls /v1/enforce/hold/{token})
      │        └── BLOCK   → throws ThothPolicyViolation
      │
      ├── Tool executes (if allowed)
      │
      └── Emits TOOL_CALL_POST event → tenant API (async, non-blocking)
```

Events are emitted to the Aten ingest API asynchronously and never block tool execution. If the
enforcer is unreachable, Thoth fails closed (`BLOCK`) and raises `ThothPolicyViolation` before
tool execution.

Streaming tools (async generators) are supported: `TOOL_CALL_PRE` is emitted before the first
yield, `TOOL_CALL_POST` is emitted after generator exhaustion.

---

## LangChain.js and LangGraph.js

`governLangChainTools` governs LangChain tools (`tool()`, `StructuredTool`,
`DynamicTool`). LangGraph.js's `ToolNode` and `createReactAgent`, and
LangChain agents, all run tools through `tool.invoke`, so pass them the
governed tools. (`instrument()` wraps tools with a `.run` method, which
LangChain.js tools don't have; use `governLangChainTools` for them.)

```typescript
import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { governLangChainTools } from "@atensec/thoth/langchain";

const listOrders = tool(async ({ account }) => orders.list(account), {
  name: "list_orders",
  description: "List open orders for an account",
  schema: z.object({ account: z.string() }),
});

// Per request: the tools you define once stay unchanged.
const tools = governLangChainTools([listOrders], {
  agentId: "trader",
  tenantId: process.env.THOTH_TENANT_ID!,
  approvedScope: [],
  userId: request.user.email,
});
const toolNode = new ToolNode(tools);
```

Each call is checked with the tool's arguments (a LangGraph `ToolCall` by its
`args`). A refused call throws `ThothPolicyViolation` and the tool never runs.
LangGraph's `ToolNode` returns that to the model as an error message by
default; with `new ToolNode(tools, { handleToolErrors: false })` it stops the
run instead.

---

## Framework Integrations

For frameworks that don't use the `.tools[].run` shape, use the dedicated integration helpers.

### Anthropic Claude

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropicTools } from "@atensec/thoth/anthropic";
// or: import { wrapAnthropicTools } from "@atensec/thoth";

const client = new Anthropic();

const wrappedFns = wrapAnthropicTools(
  { search_docs: mySearchFn, delete_record: myDeleteFn },
  {
    agentId: "claude-research-agent",
    approvedScope: ["search_docs"],
    tenantId: "acme-corp",
    apiUrl: "https://enforce.acme-corp.atensecurity.com",
    userId: "alice@acme.com",
    enforcement: "step_up",
  },
);

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Find our data retention policy." },
];

while (true) {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    tools: TOOLS,
    messages,
  });
  if (response.stop_reason === "end_turn") break;
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type === "tool_use") {
      const fn = wrappedFns[block.name];
      if (fn) {
        const result = await fn(block.input); // governance runs here
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(result),
        });
      }
    }
  }
  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: toolResults });
}
```

### OpenAI Function Calling

```typescript
import OpenAI from "openai";
import { wrapOpenAITools } from "@atensec/thoth/openai";
// or: import { wrapOpenAITools } from "@atensec/thoth";

const client = new OpenAI();

const wrappedFns = wrapOpenAITools(
  { search_docs: mySearchFn, send_email: mySendEmailFn },
  {
    agentId: "openai-agent",
    approvedScope: ["search_docs"],
    tenantId: "acme-corp",
    apiUrl: "https://enforce.acme-corp.atensecurity.com",
    userId: "charlie@acme.com",
    enforcement: "block",
  },
);

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "Find docs about access control" },
];

while (true) {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    tools: TOOLS,
    messages,
  });
  const msg = response.choices[0].message;
  if (!msg.tool_calls?.length) break;
  messages.push(msg);
  for (const call of msg.tool_calls) {
    const fn = wrappedFns[call.function.name];
    if (fn) {
      const args = JSON.parse(call.function.arguments) as Record<
        string,
        unknown
      >;
      const result = await fn(args); // governance runs here
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result),
      });
    }
  }
}
```

### Claude Agent SDK

`governClaudeAgentOptions` adds Thoth to `query()` options as hooks, so every
tool call the agent makes (built-in tools, MCP tools and your own) is checked
before it runs. It uses a PreToolUse hook rather than `canUseTool`, which the
SDK skips for tools already allowed.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { governClaudeAgentOptions } from "@atensec/thoth/claude-agent-sdk";

for await (const message of query({
  prompt: "Summarise today's open orders",
  options: governClaudeAgentOptions(
    { allowedTools: ["mcp__orders__list_orders"] },
    {
      agentId: "trader",
      tenantId: process.env.THOTH_TENANT_ID!,
      approvedScope: [],
      userId: request.user.email,
    },
  ),
})) {
  // ...
}
```

When Thoth allows a call, the SDK's own permission rules still apply; Thoth
never grants what they refuse. A refused call is denied with Thoth's reason,
which the model sees, and the tool never runs; so is a call Thoth can't check.
A held call waits for a reviewer (the hook allows 16 minutes). If Thoth would
change a call's arguments, the call is denied. Your own hooks are kept and run
first.

### MCP clients

`governMcpClient` governs every tool call an MCP client
(`@modelcontextprotocol/sdk`) makes, whether your code calls `callTool` or a
framework's MCP adapter does. Tools are governed by name the first time they
are called, so nothing needs listing up front.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { governMcpClient } from "@atensec/thoth/mcp";

const client = governMcpClient(
  new Client({ name: "trader", version: "1.0.0" }),
  {
    agentId: "trader",
    tenantId: process.env.THOTH_TENANT_ID!,
    approvedScope: [],
    userId: request.user.email,
  },
);
await client.connect(transport);
await client.callTool({ name: "list_orders", arguments: { account: "A-1" } });
```

A refused call rejects with `ThothPolicyViolation` and never reaches the MCP
server. Tools from `listTools()` are reported to the tool inventory. If a
governed framework tool calls this client, the call is checked once, not twice.
For desktop MCP clients you don't run in your own code, use the
[Thoth MCP proxy](https://docs.atensecurity.com/docs/mcp/proxy).

### Vercel AI SDK

`governAiSdkTools` governs a tool set for `generateText`, `streamText` or an
`Agent` (AI SDK 7). Each tool with an `execute` is checked before it runs, with
the tool's input as its arguments; the call options (`toolCallId`,
`abortSignal`, messages) reach your `execute` unchanged. Tools without
`execute` are left as they are.

```typescript
import { generateText, tool } from "ai";
import { z } from "zod";
import { governAiSdkTools } from "@atensec/thoth/ai-sdk";

const tools = governAiSdkTools(
  {
    listOrders: tool({
      description: "List open orders for an account",
      inputSchema: z.object({ account: z.string() }),
      execute: async ({ account }) => orders.list(account),
    }),
  },
  {
    agentId: "trader",
    tenantId: process.env.THOTH_TENANT_ID!,
    approvedScope: ["listOrders"],
    userId: request.user.email,
  },
);

await generateText({ model, tools, prompt: "What's open on A-1?" });
```

A refused call throws `ThothPolicyViolation` from `execute` and the original
never runs; the AI SDK records it as the tool call's error. Call
`governAiSdkTools` once per session, for example per request.

---

## Configuration Reference

All options are passed as the second argument to `instrument()`, `wrapAnthropicTools()`,
`wrapOpenAITools()`, or the `ThothClient.instrument*()` methods.

| Field                  | Type                        | Required | Default          | Description                                                                    |
| ---------------------- | --------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------ |
| `agentId`              | `string`                    | Yes      | —                | Stable identifier for this agent. Used in policy rules and dashboard grouping. |
| `tenantId`             | `string`                    | Yes      | —                | Your Maat tenant ID.                                                           |
| `approvedScope`        | `string[]`                  | Yes      | —                | List of tool names this agent is authorized to call.                           |
| `apiUrl`               | `string`                    | Yes\*    | `$THOTH_API_URL` | Tenant API base URL used for both `/v1/enforce` and `/v1/events/batch`.        |
| `userId`               | `string`                    | No       | `"system"`       | Identity of the user on whose behalf the agent acts.                           |
| `enforcement`          | `EnforcementMode \| string` | No       | `"block"`        | Enforcement mode: `observe`, `step_up`, `block`, or `progressive`.             |
| `failOpen`             | `boolean`                   | No       | `false`          | Allow on enforcer infrastructure failures (`network`, `429`, `5xx`).           |
| `apiKey`               | `string`                    | No       | `$THOTH_API_KEY` | API key from the Aten dashboard.                                               |
| `stepUpTimeoutMinutes` | `number`                    | No       | `15`             | How long to wait for human approval before timing out a step-up hold.          |
| `stepUpPollIntervalMs` | `number`                    | No       | `5000`           | How often to poll the enforcer for step-up approval status (milliseconds).     |

\* `apiUrl` may be omitted only when `THOTH_API_URL` is set.

### TypeScript types

```typescript
import type {
  ThothConfig,
  BehavioralEvent,
  EnforcementDecision,
} from "@atensec/thoth";
import {
  EnforcementMode,
  DecisionType,
  EventType,
  SourceType,
} from "@atensec/thoth";
```

---

## Error Handling

When enforcement mode is `block` or `progressive` and the enforcer returns a `BLOCK` decision,
Thoth throws a `ThothPolicyViolation` before the tool executes:

```typescript
import { instrument, ThothPolicyViolation } from "@atensec/thoth";

const governed = instrument(agent, {
  agentId: "sensitive-agent",
  approvedScope: ["read_file"],
  tenantId: "acme-corp",
  enforcement: "block",
});

try {
  const result = await governed.tools[0].run("/etc/passwd");
} catch (err) {
  if (err instanceof ThothPolicyViolation) {
    // err.toolName    — the tool that was blocked
    // err.reason      — human-readable policy reason
    // err.violationId — reference ID for the violation record in the Maat dashboard
    console.warn(`Blocked: ${err.toolName} — ${err.reason}`);
    if (err.violationId) {
      console.warn(`Violation record: ${err.violationId}`);
    }
    return {
      error: "This action is not permitted under your current access policy.",
    };
  }
  throw err;
}
```

`ThothPolicyViolation` extends `Error`, so existing error handling and logging pipelines pick it
up automatically.

---

## Environment Variables

| Variable          | Description                                                                                                                         | Example                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `THOTH_API_KEY`   | API key from the Aten dashboard. Used as default if `apiKey` config option is not set.                                              | `thoth_live_abc123...`                   |
| `THOTH_API_URL`   | Tenant API base URL used for both enforcement and event ingestion when `apiUrl` is not provided.                                    | `https://enforce.<tenant>.<apex-domain>` |
| `THOTH_FAIL_OPEN` | Optional fail-open switch (`true/false`). When true, enforcer `network/429/5xx` failures return `ALLOW`. Auth failures still block. | `true`                                   |
| `THOTH_LOG_LEVEL` | Optional SDK decision-log level override (`DEBUG`, `INFO`, `WARN`, `ERROR`). Falls back to `LOG_LEVEL` when unset.                  | `DEBUG`                                  |

When decision logging is enabled at debug level, SDK decision logs include `hold_token` for
`STEP_UP` flows.

---

## Enforcement Modes

| Mode        | Value         | Behavior                                                                                                                          |
| ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Observe     | `observe`     | All tool calls pass through. Events are still emitted for audit. No blocking, no step-up. Use for initial rollout and baselining. |
| Step-Up     | `step_up`     | Suspicious calls trigger a human approval request. Tool execution is held until approved or timed out.                            |
| Block       | `block`       | Calls that violate policy throw `ThothPolicyViolation` immediately before the tool executes.                                      |
| Progressive | `progressive` | Escalating mode. The enforcer chooses the appropriate response per tool call based on policy rules.                               |

---

## Policy Decisions

The enforcer returns one of three decisions for each tool call:

| Decision  | Meaning                       | Agent behavior                                                                                        |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ALLOW`   | Call is within policy.        | Tool executes immediately.                                                                            |
| `STEP_UP` | Call requires human approval. | SDK polls `/v1/enforce/hold/{token}` until approved or timed out. On timeout: `ThothPolicyViolation`. |
| `BLOCK`   | Call violates policy.         | `ThothPolicyViolation` is thrown before the tool executes.                                            |

By default, enforcer errors fail closed (`BLOCK`). Set `failOpen: true` (or `THOTH_FAIL_OPEN=true`)
to allow on infrastructure failures (`network`, `429`, `5xx`). Authentication failures remain blocked.

---

## Dashboard

View sessions, violations, step-up requests, and policy decisions in your Thoth dashboard at
`https://<tenant>.<apex-domain>`.

The dashboard shows:

- **Sessions** — per-agent session timelines with all tool calls
- **Violations** — blocked or escalated actions with full context
- **Approvals** — step-up queue for human reviewers
- **Policies** — view and edit the rules driving enforcement decisions
- **Behavioral Analytics** — drift detection and anomaly scores over time

---

## License

Apache-2.0 — Copyright 2026 Aten Security, Inc. See [LICENSE](./LICENSE) for details.

## Telemetry privacy

Default telemetry omits tool payloads and free-text context while retaining decision evidence. Authorization requests still send original inputs to the configured tenant API. See [privacy boundaries and compatibility notes](PRIVACY.md).
