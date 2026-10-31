/**
 * Mastra integration for @atensec/thoth.
 *
 * Governs the tools you give a Mastra `Agent` (`createTool()` tools, keyed by
 * name): each call is checked by Thoth before the tool's `execute` runs, with
 * the tool's input as its arguments. Mastra's execution context (request
 * context, abort signal, writer) reaches `execute` unchanged.
 *
 * @example
 * ```typescript
 * import { Agent } from "@mastra/core/agent";
 * import { governMastraTools } from "@atensec/thoth/mastra";
 *
 * const agent = new Agent({
 *   name: "trader",
 *   instructions: "...",
 *   model,
 *   tools: governMastraTools({ listOrders, wireFunds }, {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * ```
 *
 * A refused call throws ThothPolicyViolation from `execute` and the tool never
 * runs; Mastra reports it to the model as the tool call's error.
 */
import { governExecutes } from "./govern.js";
/**
 * Returns governed copies of `tools`, keyed the same; Thoth sees each tool by
 * its key, the name the model calls it by. The copies keep each tool's own
 * fields and class. Tools without `execute` are returned as they are, and the
 * tools passed in are unchanged, so govern them per agent run or request.
 */
export function governMastraTools(tools, config) {
    const executable = Object.entries(tools).filter(([, tool]) => typeof tool.execute === "function");
    const governed = governExecutes(executable.map(([name, tool]) => ({
        name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema,
        execute: tool.execute.bind(tool),
    })), config);
    const out = { ...tools };
    for (const [name, tool] of executable) {
        // A copy with the tool's own fields and prototype, so Mastra still sees the
        // same kind of tool, whether it reads fields, spreads it or checks its class.
        out[name] = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
            execute: governed.get(name),
        });
    }
    return out;
}
//# sourceMappingURL=mastra.js.map