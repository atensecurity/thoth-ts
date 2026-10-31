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
import type { ThothConfig } from "../models.js";
/** The parts of a LangChain tool this integration uses. */
export interface LangChainToolLike {
    name: string;
    description?: string;
    schema?: unknown;
    invoke(input: never, config?: never): Promise<unknown>;
}
/**
 * Returns governed copies of `tools`, in the same order. The tools you pass
 * in are unchanged, so define them once and govern them per session (for
 * example per request, with that request's `userId`).
 */
export declare function governLangChainTools<T extends LangChainToolLike>(tools: readonly T[], config: ThothConfig): T[];
//# sourceMappingURL=langchain.d.ts.map