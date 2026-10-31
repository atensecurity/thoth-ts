/**
 * Google Agent Development Kit (ADK) integration for @atensec/thoth.
 *
 * Governs an ADK agent's tools (`FunctionTool`, MCP tools, agent tools): each
 * call is checked by Thoth when the tool runs, with its final arguments, and
 * the tool runs with exactly the arguments Thoth checked. ADK runs every tool
 * through `runAsync({ args, toolContext })`; the tool context reaches the tool
 * unchanged.
 *
 * Checking at the tool, rather than in a `beforeToolCallback`, means another
 * callback can't change the arguments after the check.
 *
 * @example
 * ```typescript
 * import { LlmAgent } from "@google/adk";
 * import { governAdkTools } from "@atensec/thoth/google-adk";
 *
 * const agent = new LlmAgent({
 *   name: "trader",
 *   model: "gemini-2.5-flash",
 *   tools: governAdkTools([listOrders, wireFunds], {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * ```
 *
 * A refused call never runs: `runAsync` throws ThothPolicyViolation.
 */
import { governExecutes } from "./govern.js";
function declaredSchema(tool) {
    try {
        const declaration = tool._getDeclaration?.();
        return declaration?.parametersJsonSchema ?? declaration?.parameters;
    }
    catch {
        // Advisory metadata must never affect governance.
        return undefined;
    }
}
/**
 * Returns governed copies of `tools`, in the same order, in one Thoth
 * session. The copies keep each tool's fields and class; the tools passed in
 * are unchanged, so govern them per agent or request.
 */
export function governAdkTools(tools, config) {
    const governed = governExecutes(tools.map((tool) => {
        const runAsync = tool.runAsync.bind(tool);
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: declaredSchema(tool),
            // Runs with exactly the arguments Thoth checked.
            execute: (args, toolContext) => runAsync({ args, toolContext }),
        };
    }), config);
    return tools.map((tool) => {
        const run = governed.get(tool.name);
        return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
            runAsync: (request) => run(request.args ?? {}, request.toolContext),
        });
    });
}
//# sourceMappingURL=google-adk.js.map