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
import { AsyncLocalStorage } from "node:async_hooks";
import { openSession } from "../instrumentor.js";
import { ThothPolicyViolation } from "../models.js";
import { jsonSchemaOf } from "./govern.js";
function parseArgs(input) {
    try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        /* Not JSON: checked as the raw text. */
    }
    return { input };
}
/**
 * Returns `tools` with every function tool replaced by a governed copy, in
 * the same order and one Thoth session. Other tools are returned as they are,
 * and the tools passed in are unchanged, so govern them per run or request.
 */
export function governOpenAIAgentTools(tools, config) {
    const session = openSession(config);
    const functions = tools.filter((tool) => tool.type === "function" &&
        typeof tool.name === "string" &&
        typeof tool.invoke === "function");
    session.report(functions.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: jsonSchemaOf(tool.parameters),
    })));
    return tools.map((original) => {
        const tool = original;
        if (!functions.includes(tool))
            return original;
        const invoke = tool.invoke.bind(tool);
        const call = new AsyncLocalStorage();
        const governed = session.wrap(tool.name, (checked) => {
            const current = call.getStore();
            if (!current)
                throw new Error("governed tool called outside a run");
            // Unchanged arguments reach the tool exactly as the model sent them.
            const input = JSON.stringify(checked) === JSON.stringify(current.parsed)
                ? current.input
                : JSON.stringify(checked);
            return invoke(current.runContext, input, current.details);
        });
        const governedInvoke = (runContext, input, details) => {
            const parsed = parseArgs(input);
            return call
                .run({ runContext, input, parsed, details }, () => Promise.resolve(governed(parsed)))
                .catch((error) => {
                // As the SDK does for a tool's own errors: the model is told and the
                // run continues. The tool did not run, and Thoth recorded the refusal.
                if (error instanceof ThothPolicyViolation) {
                    return `Thoth refused this call: ${error.reason}`;
                }
                throw error;
            });
        };
        // A copy with the tool's own fields and prototype; only invoke changes.
        return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
            invoke: governedInvoke,
        });
    });
}
//# sourceMappingURL=openai-agents.js.map