/**
 * Strands Agents integration for @atensec/thoth.
 *
 * Governs a Strands agent's tools (`tool()`, MCP tools, vended tools): each
 * call is checked by Thoth when the tool runs, with the call's final input,
 * and the tool runs with exactly the input Thoth checked.
 *
 * Checking at the tool, rather than in a BeforeToolCallEvent hook, means a
 * hook registered after Thoth's can't change the input after the check.
 *
 * @example
 * ```typescript
 * import { Agent } from "@strands-agents/sdk";
 * import { governStrandsTools } from "@atensec/thoth/strands";
 *
 * const agent = new Agent({
 *   tools: governStrandsTools([listOrders, wireFunds], {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * await agent.invoke("What's open on A-1?");
 * ```
 *
 * A refused call never runs: the tool's stream throws ThothPolicyViolation,
 * which Strands reports to the model as the tool's error.
 */
import type { ThothConfig } from "../models.js";
/** The parts of a Strands tool this integration uses. */
export interface StrandsToolLike {
    name: string;
    description?: string;
    toolSpec?: {
        inputSchema?: unknown;
    };
    stream(toolContext: never): AsyncGenerator<unknown, unknown, unknown>;
}
/**
 * Returns governed copies of `tools`, in the same order, in one Thoth
 * session. The copies keep each tool's fields and class; the tools passed in
 * are unchanged, so govern them per agent or request.
 */
export declare function governStrandsTools<T extends StrandsToolLike>(tools: readonly T[], config: ThothConfig): T[];
//# sourceMappingURL=strands.d.ts.map