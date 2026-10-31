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
 * server. A call already checked by a governed wrapper (a framework tool that
 * calls this client) is not checked a second time.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { alreadyGoverned, openSession } from "../instrumentor.js";
import { jsonSchemaOf } from "./govern.js";
/**
 * Governs `client.callTool` (and reports listed tools to the tool inventory).
 * Returns the same client. Govern one client per session, for example per
 * request with that request's `userId`.
 */
export function governMcpClient(client, config) {
    const session = openSession(config);
    const original = client.callTool.bind(client);
    // The call's other parts: everything in params but its arguments, and the
    // result schema and request options, which never go to Thoth.
    const call = new AsyncLocalStorage();
    const governed = new Map();
    const callTool = (params, ...rest) => {
        const name = params?.name;
        if (typeof name !== "string" || !name || alreadyGoverned(name)) {
            return original(params, ...rest);
        }
        let run = governed.get(name);
        if (!run) {
            run = session.wrap(name, (checked) => {
                const current = call.getStore();
                return original({
                    ...(current?.params ?? params),
                    arguments: checked,
                }, ...(current?.rest ?? rest));
            });
            governed.set(name, run);
        }
        const governedRun = run;
        return call.run({ params, rest }, () => Promise.resolve(governedRun(params.arguments ?? {})));
    };
    client.callTool = callTool;
    const listTools = client.listTools?.bind(client);
    if (listTools) {
        const reported = new Set();
        client.listTools = async (...args) => {
            const result = await listTools(...args);
            const fresh = (result?.tools ?? []).filter((tool) => typeof tool.name === "string" && !reported.has(tool.name));
            for (const tool of fresh)
                reported.add(tool.name);
            if (fresh.length) {
                session.report(fresh.map((tool) => ({
                    name: tool.name,
                    description: tool.description ?? "",
                    inputSchema: jsonSchemaOf(tool.inputSchema),
                })));
            }
            return result;
        };
    }
    return client;
}
//# sourceMappingURL=mcp.js.map