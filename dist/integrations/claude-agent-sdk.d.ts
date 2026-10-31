/**
 * Claude Agent SDK integration for @atensec/thoth.
 *
 * Adds Thoth to `query()` options as hooks, so every tool call the agent makes
 * (built-in tools, MCP tools and your own) is checked before it runs. A
 * PreToolUse hook is used, not `canUseTool`: the SDK skips `canUseTool` for
 * tools already allowed (`allowedTools`, or bypass-permissions mode), while
 * PreToolUse runs before every tool call.
 *
 * @example
 * ```typescript
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { governClaudeAgentOptions } from "@atensec/thoth/claude-agent-sdk";
 *
 * for await (const message of query({
 *   prompt: "Summarise today's open orders",
 *   options: governClaudeAgentOptions(
 *     { allowedTools: ["mcp__orders__list_orders"] },
 *     { agentId: "trader", tenantId: process.env.THOTH_TENANT_ID!, approvedScope: [], userId },
 *   ),
 * })) { ... }
 * ```
 *
 * - Thoth allows: the hook returns no decision, so the SDK's own permission
 *   rules still apply. Thoth never grants what they would refuse.
 * - Thoth refuses (or the check fails): the hook denies the call with
 *   Thoth's reason, which the model sees; the tool never runs.
 * - Thoth would change the arguments: the call is denied, because the SDK
 *   doesn't document passing changed input without overriding its own
 *   permission rules.
 * - A held call waits for a reviewer, up to the hook timeout (16 minutes).
 *
 * The call's completion is recorded when the tool finishes (PostToolUse).
 */
import { type ThothConfig } from "../models.js";
/** The parts of the SDK's options this integration sets (its `Options` fits). */
export interface ClaudeAgentOptionsLike {
    hooks?: Partial<Record<string, readonly object[]>>;
}
/**
 * Returns a copy of `options` with Thoth's PreToolUse, PostToolUse and
 * PostToolUseFailure hooks added after any you already set. One Thoth session
 * per call: govern the options for each `query()`, with that run's `userId`.
 */
export declare function governClaudeAgentOptions<O extends ClaudeAgentOptionsLike>(options: O, config: ThothConfig): O;
//# sourceMappingURL=claude-agent-sdk.d.ts.map