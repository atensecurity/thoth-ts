/**
 * MCP client integration for @atensec/thoth.
 *
 * Governs every tool call an MCP client (`@modelcontextprotocol/sdk`) makes,
 * whatever framework or loop drives it: the AI SDK's and LangChain.js's MCP
 * adapters, and your own code, all call `client.callTool`. Tools are governed
 * by name as they are first called, in one Thoth session, so an MCP server's
 * tools need no listing up front.
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { governMcpClient } from "@atensec/thoth/mcp";
 *
 * const client = governMcpClient(new Client({ name: "trader", version: "1.0.0" }), {
 *   agentId: "trader",
 *   tenantId: process.env.THOTH_TENANT_ID!,
 *   approvedScope: [],
 *   userId,
 * });
 * await client.connect(transport);
 * await client.callTool({ name: "list_orders", arguments: { account: "A-1" } });
 * ```
 *
 * A refused call rejects with ThothPolicyViolation and never reaches the MCP
 * server. When a governed framework tool calls this client for the same tool
 * with the same arguments Thoth just checked, that one call isn't checked a
 * second time; any other call inside it is.
 */
import type { ThothConfig } from "../models.js";
/** The parts of an MCP client this integration uses. */
export interface McpClientLike {
    callTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
    }, ...rest: never[]): Promise<unknown>;
    listTools?(...args: never[]): Promise<{
        tools?: {
            name?: string;
            description?: string;
            inputSchema?: unknown;
        }[];
    }>;
}
/**
 * Governs `client.callTool` (and reports listed tools to the tool inventory).
 * Returns the same client. Govern one client per session, for example per
 * request with that request's `userId`.
 */
export declare function governMcpClient<C extends McpClientLike>(client: C, config: ThothConfig): C;
//# sourceMappingURL=mcp.d.ts.map