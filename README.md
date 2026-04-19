# @atensec/thoth

AI agent governance SDK for JavaScript/TypeScript by [Aten Security](https://atensecurity.com).

Thoth instruments your AI agents for governance, policy enforcement, and behavioral monitoring.
Every tool call is evaluated against your organization's security policies — blocking, stepping up
for human approval, or silently observing based on your configured enforcement mode.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [How It Works](#how-it-works)
4. [LangChain.js Example](#langchainjs-example)
5. [Framework Integrations](#framework-integrations)
   - [Anthropic Claude](#anthropic-claude)
   - [OpenAI Function Calling](#openai-function-calling)
6. [Configuration Reference](#configuration-reference)
7. [Error Handling](#error-handling)
8. [Environment Variables](#environment-variables)
9. [Enforcement Modes](#enforcement-modes)
10. [Policy Decisions](#policy-decisions)
11. [Dashboard](#dashboard)

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

**Requirements:** Node.js 18+, TypeScript 5.x (if using types)

---

## Quick Start

**1. Get your API key** from your Thoth dashboard at `https://<tenant>.<apex-domain>` under
**Settings → API Keys**.

**2. Set environment variables:**

```bash
export THOTH_API_KEY="thoth_live_..."
export THOTH_API_URL="https://enforce.<tenant>.<apex-domain>"
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
  enforcement: "progressive", // observe | step_up | block | progressive
  // apiKey reads from THOTH_API_KEY env var automatically
});

// Every tool call is now governed — no other changes required
const result = await governed.run(
  "Summarize the attached document and send it to the team.",
);
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
enforcer is unreachable, Thoth fails open (`ALLOW`) — it never interrupts production traffic due
to an infrastructure fault.

Streaming tools (async generators) are supported: `TOOL_CALL_PRE` is emitted before the first
yield, `TOOL_CALL_POST` is emitted after generator exhaustion.

---

## LangChain.js Example

Thoth works with any object that has a `.tools` array where each tool has a `.run` method.
This includes LangChain.js `AgentExecutor` instances:

```typescript
import { AgentExecutor, createOpenAIToolsAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { instrument } from "@atensec/thoth";

const webSearch = new DynamicTool({
  name: "web_search",
  description: "Search the web for current information.",
  func: async (query: string) => {
    // your search implementation
    return `Results for: ${query}`;
  },
});

const readFile = new DynamicTool({
  name: "read_file",
  description: "Read a file from the local filesystem.",
  func: async (path: string) => {
    // your file read implementation
    return `Contents of ${path}`;
  },
});

const llm = new ChatOpenAI({ model: "gpt-4o" });
const agent = await createOpenAIToolsAgent({
  llm,
  tools: [webSearch, readFile],
  prompt,
});

const executor = new AgentExecutor({
  agent,
  tools: [webSearch, readFile],
});

// One call instruments all tools on the executor
const governed = instrument(executor, {
  agentId: "research-agent",
  approvedScope: ["web_search", "read_file"],
  tenantId: "acme-corp",
  userId: "bob@acme.com",
  enforcement: "block",
});

// Every tool invocation is now policy-checked
const result = await governed.invoke({
  input: "Find recent SEC filings for AAPL",
});
```

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

---

## Configuration Reference

All options are passed as the second argument to `instrument()`, `wrapAnthropicTools()`, or
`wrapOpenAITools()`.

| Field                  | Type                        | Required | Default          | Description                                                                    |
| ---------------------- | --------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------ |
| `agentId`              | `string`                    | Yes      | —                | Stable identifier for this agent. Used in policy rules and dashboard grouping. |
| `tenantId`             | `string`                    | Yes      | —                | Your Maat tenant ID.                                                           |
| `approvedScope`        | `string[]`                  | Yes      | —                | List of tool names this agent is authorized to call.                           |
| `apiUrl`               | `string`                    | Yes\*    | `$THOTH_API_URL` | Tenant API base URL used for both `/v1/enforce` and `/v1/events/batch`.        |
| `userId`               | `string`                    | No       | `"system"`       | Identity of the user on whose behalf the agent acts.                           |
| `enforcement`          | `EnforcementMode \| string` | No       | `"progressive"`  | Enforcement mode: `observe`, `step_up`, `block`, or `progressive`.             |
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

| Variable        | Description                                                                                      | Example                                  |
| --------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `THOTH_API_KEY` | API key from the Aten dashboard. Used as default if `apiKey` config option is not set.           | `thoth_live_abc123...`                   |
| `THOTH_API_URL` | Tenant API base URL used for both enforcement and event ingestion when `apiUrl` is not provided. | `https://enforce.<tenant>.<apex-domain>` |

---

## Enforcement Modes

| Mode        | Value         | Behavior                                                                                                                          |
| ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Observe     | `observe`     | All tool calls pass through. Events are still emitted for audit. No blocking, no step-up. Use for initial rollout and baselining. |
| Step-Up     | `step_up`     | Suspicious calls trigger a human approval request. Tool execution is held until approved or timed out.                            |
| Block       | `block`       | Calls that violate policy throw `ThothPolicyViolation` immediately before the tool executes.                                      |
| Progressive | `progressive` | Default. The enforcer chooses the appropriate response per tool call based on policy rules.                                       |

---

## Policy Decisions

The enforcer returns one of three decisions for each tool call:

| Decision  | Meaning                       | Agent behavior                                                                                        |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ALLOW`   | Call is within policy.        | Tool executes immediately.                                                                            |
| `STEP_UP` | Call requires human approval. | SDK polls `/v1/enforce/hold/{token}` until approved or timed out. On timeout: `ThothPolicyViolation`. |
| `BLOCK`   | Call violates policy.         | `ThothPolicyViolation` is thrown before the tool executes.                                            |

Enforcer errors (network timeout, 5xx) always result in `ALLOW` so that infrastructure faults
never interrupt production workloads.

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
