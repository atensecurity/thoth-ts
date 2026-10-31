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
import type { ThothConfig } from "../models.js";
/** The parts of an ADK tool this integration uses. */
export interface AdkToolLike {
    name: string;
    description?: string;
    runAsync(request: {
        args: Record<string, unknown>;
        toolContext: never;
    }): Promise<unknown>;
    _getDeclaration?(): {
        parameters?: unknown;
        parametersJsonSchema?: unknown;
    } | undefined;
}
/**
 * Returns governed copies of `tools`, in the same order, in one Thoth
 * session. The copies keep each tool's fields and class; the tools passed in
 * are unchanged, so govern them per agent or request.
 */
export declare function governAdkTools<T extends AdkToolLike>(tools: readonly T[], config: ThothConfig): T[];
//# sourceMappingURL=google-adk.d.ts.map