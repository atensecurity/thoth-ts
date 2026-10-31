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
import { AsyncLocalStorage } from "node:async_hooks";
import { openSession } from "../instrumentor.js";
import { ThothPolicyViolation } from "../models.js";
import { jsonSchemaOf } from "./govern.js";
/** The model's arguments as a JSON object, or null when they aren't one. */
function parseArgs(input) {
    try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        /* Not JSON. */
    }
    return null;
}
function toolLabel(tool) {
    return `${tool.type ?? "unknown"} tool${tool.name ? ` "${tool.name}"` : ""}`;
}
/**
 * Returns `tools` with every function tool replaced by a governed copy, in
 * the same order and one Thoth session. Hosted tools are returned as they
 * are. Throws if the list holds a local tool Thoth can't check that isn't
 * named in `options.ungoverned`. The tools passed in are unchanged, so
 * govern them per run or request.
 */
export function governOpenAIAgentTools(tools, config, options = {}) {
    const list = tools;
    const isFunction = (tool) => tool.type === "function" &&
        typeof tool.name === "string" &&
        typeof tool.invoke === "function";
    const allowed = new Set(options.ungoverned ?? []);
    const unchecked = list.filter((tool) => !isFunction(tool) &&
        tool.type !== "hosted_tool" &&
        !(typeof tool.name === "string" && allowed.has(tool.name)));
    if (unchecked.length) {
        throw new Error(`Thoth can't check ${unchecked.map(toolLabel).join(", ")}: it runs in this process outside a function tool. ` +
            "Remove it, wrap what it does in a function tool, or name it in options.ungoverned to run it unchecked.");
    }
    const session = openSession(config);
    const functions = list.filter(isFunction);
    session.report(functions.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: jsonSchemaOf(tool.parameters),
    })));
    return tools.map((original) => {
        const tool = original;
        if (!functions.includes(tool))
            return original;
        const name = tool.name;
        const invoke = tool.invoke.bind(tool);
        const call = new AsyncLocalStorage();
        const governed = session.wrap(name, (checked) => {
            const current = call.getStore();
            if (!current)
                throw new Error("governed tool called outside a run");
            // Always the JSON of exactly what Thoth checked, never the raw input,
            // so the checked and executed arguments can't differ.
            return invoke(current.runContext, JSON.stringify(checked), current.details);
        });
        const refused = (reason) => `Thoth refused this call: ${reason}`;
        const governedInvoke = (runContext, input, details) => {
            const parsed = parseArgs(input);
            if (parsed === null) {
                // Nothing Thoth can check, so the tool doesn't run.
                return Promise.resolve(refused("the arguments aren't a JSON object, so they can't be checked"));
            }
            return call
                .run({ runContext, details }, () => Promise.resolve(governed(parsed)))
                .catch((error) => {
                // As the SDK does for a tool's own errors: the model is told and the
                // run continues. The tool did not run, and Thoth recorded the refusal.
                if (error instanceof ThothPolicyViolation) {
                    return refused(error.reason);
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