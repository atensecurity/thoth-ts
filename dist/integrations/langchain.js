/**
 * LangChain.js and LangGraph.js integration for @atensec/thoth.
 *
 * Governs LangChain tools (`tool()`, `StructuredTool`, `DynamicTool`), which
 * LangGraph.js's `ToolNode` and `createReactAgent`, and LangChain agents, all
 * run through `tool.invoke`. Each call is checked by Thoth before the tool
 * runs, with the tool's arguments; a LangGraph `ToolCall` is checked by its
 * `args`.
 *
 * @example
 * ```typescript
 * import { ToolNode } from "@langchain/langgraph/prebuilt";
 * import { governLangChainTools } from "@atensec/thoth/langchain";
 *
 * const tools = governLangChainTools([listOrders, wireFunds], {
 *   agentId: "trader",
 *   tenantId: process.env.THOTH_TENANT_ID!,
 *   approvedScope: [],
 *   userId,
 * });
 * const node = new ToolNode(tools);
 * ```
 *
 * A refused call throws ThothPolicyViolation and the tool never runs. By
 * default LangGraph's ToolNode returns that to the model as an error
 * message; with `handleToolErrors: false` it stops the run instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { openSession } from "../instrumentor.js";
import { jsonSchemaOf } from "./govern.js";
function isToolCall(input) {
    return (typeof input === "object" &&
        input !== null &&
        input.type === "tool_call" &&
        typeof input.args === "object");
}
/**
 * Returns governed copies of `tools`, in the same order. The tools you pass
 * in are unchanged, so define them once and govern them per session (for
 * example per request, with that request's `userId`).
 */
export function governLangChainTools(tools, config) {
    const session = openSession(config);
    session.report(tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: jsonSchemaOf(tool.schema),
    })));
    return tools.map((tool) => {
        const original = tool.invoke.bind(tool);
        const call = new AsyncLocalStorage();
        const governed = session.wrap(tool.name, (checked) => {
            const current = call.getStore();
            const input = current?.input;
            // Run with the arguments Thoth checked, in the shape the tool was called with.
            return original(isToolCall(input) ? { ...input, args: checked } : checked, current?.config);
        });
        const invoke = (input, runConfig) => call.run({ input, config: runConfig }, () => Promise.resolve(governed(isToolCall(input) ? input.args : input)));
        // The copy keeps everything else from the tool (name, schema, metadata).
        const copy = Object.create(tool);
        copy.invoke = invoke;
        copy.call = invoke;
        return copy;
    });
}
//# sourceMappingURL=langchain.js.map