/**
 * OpenAI Agents SDK integration for @atensec/thoth.
 *
 * Governs an agent's function tools (`tool()` from `@openai/agents`): each
 * call is checked by Thoth before the tool runs, with the arguments the model
 * sent (parsed from the call's JSON). The run context and call details reach
 * the tool unchanged. Hosted tools (web search, file search, code
 * interpreter) run at OpenAI, outside this process, and are left as they are.
 *
 * @example
 * ```typescript
 * import { Agent, run, tool } from "@openai/agents";
 * import { governOpenAIAgentTools } from "@atensec/thoth/openai-agents";
 *
 * const agent = new Agent({
 *   name: "trader",
 *   instructions: "...",
 *   tools: governOpenAIAgentTools([listOrders, wireFunds], {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * await run(agent, "What's open on A-1?");
 * ```
 *
 * A refused call never runs. The model gets "Thoth refused this call: <reason>"
 * as the tool's output, as the SDK reports any tool error, and the run
 * continues; Thoth records the refusal and applies its consequences.
 */
import { type ThothConfig } from "../models.js";
/** The parts of an Agents SDK function tool this integration uses. */
export interface OpenAIAgentToolLike {
    type?: string;
    name?: string;
    description?: string;
    parameters?: unknown;
    invoke?: (runContext: never, input: string, details?: never) => unknown;
}
/**
 * Returns `tools` with every function tool replaced by a governed copy, in
 * the same order and one Thoth session. Other tools are returned as they are,
 * and the tools passed in are unchanged, so govern them per run or request.
 */
export declare function governOpenAIAgentTools<T extends object>(tools: readonly T[], config: ThothConfig): T[];
//# sourceMappingURL=openai-agents.d.ts.map