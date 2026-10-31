/**
 * OpenAI Agents SDK integration for @atensec/thoth.
 *
 * Governs an agent's function tools (`tool()` from `@openai/agents`): each
 * call is checked by Thoth before the tool runs, with the arguments the model
 * sent (a JSON object), and the tool runs with exactly the arguments Thoth
 * checked. The run context and call details reach the tool unchanged.
 *
 * Hosted tools (web search, file search, code interpreter) run at OpenAI,
 * outside this process, and are left as they are. Local tools this
 * integration can't check (shell, apply_patch, computer, or any other type)
 * are refused when you govern the list, unless you name them in
 * `options.ungoverned`, so none runs unchecked by accident.
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
/** The parts of an Agents SDK tool this integration uses. */
export interface OpenAIAgentToolLike {
    type?: string;
    name?: string;
    description?: string;
    parameters?: unknown;
    invoke?: (runContext: never, input: string, details?: never) => unknown;
}
export interface GovernOpenAIAgentToolsOptions {
    /**
     * Names of local, non-function tools (shell, apply_patch, computer) you
     * accept running without a Thoth check. Any other such tool is refused.
     */
    ungoverned?: readonly string[];
}
/**
 * Returns `tools` with every function tool replaced by a governed copy, in
 * the same order and one Thoth session. Hosted tools are returned as they
 * are. Throws if the list holds a local tool Thoth can't check that isn't
 * named in `options.ungoverned`. The tools passed in are unchanged, so
 * govern them per run or request.
 */
export declare function governOpenAIAgentTools<T extends object>(tools: readonly T[], config: ThothConfig, options?: GovernOpenAIAgentToolsOptions): T[];
//# sourceMappingURL=openai-agents.d.ts.map