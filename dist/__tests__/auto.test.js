import { DynamicTool, tool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { actingFor, init, namedSessionId, shutdown } from "../auto.js";
import { ThothPolicyViolation } from "../models.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";
const ran = [];
// Tenant acme, agent trader, user alice@acme.test, session conv-1; the
// Python SDK's tests use the same vector.
const SHARED_VECTOR = "b4541a04-7924-c176-3889-86833d84ef0f";
// Defined at import time, before init(), as agents usually are.
const listOrders = tool(async ({ account }) => {
    ran.push(`list_orders:${account}`);
    return `orders for ${account}`;
}, {
    name: "list_orders",
    description: "List open orders for an account",
    schema: z.object({ account: z.string() }),
});
const wireFunds = tool(async ({ amount }) => {
    ran.push(`wire_funds:${amount}`);
    return "sent";
}, {
    name: "wire_funds",
    description: "Send a wire",
    schema: z.object({ amount: z.number() }),
});
const echo = new DynamicTool({
    name: "echo",
    description: "Echo text",
    func: async (input) => {
        ran.push(`echo:${input}`);
        return input;
    },
});
/** A real MCP server, connected to a real client in memory. */
async function mcpClient() {
    const server = new McpServer({ name: "brokerage", version: "1.0.0" });
    server.registerTool("create_order", { description: "Create an order", inputSchema: { account: z.string() } }, async ({ account }) => {
        ran.push(`create_order:${account}`);
        return { content: [{ type: "text", text: `order for ${account}` }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "trader", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
}
beforeEach(() => {
    ran.length = 0;
    vi.stubEnv("THOTH_AGENT_ID", "trader");
    vi.stubEnv("THOTH_TENANT_ID", "acme");
    vi.stubEnv("THOTH_API_URL", apiUrl);
    vi.stubEnv("THOTH_API_KEY", "thoth_test_key");
});
afterEach(() => {
    shutdown();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe("init", () => {
    it("governs the frameworks installed here", async () => {
        fakeThoth();
        expect(await init()).toEqual(["langchain", "mcp_client"]);
    });
    it("checks a LangChain tool defined before init(), for the actingFor user", async () => {
        const thoth = fakeThoth();
        await init();
        const result = await actingFor("alice@acme.test", () => listOrders.invoke({ account: "A-1" }));
        expect(result).toBe("orders for A-1");
        expect(ran).toEqual(["list_orders:A-1"]);
        expect(thoth.checks).toHaveLength(1);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "list_orders",
            tool_args: { account: "A-1" },
            user_id: "alice@acme.test",
        });
    });
    it("checks a LangGraph tool call by its args and keeps its shape", async () => {
        const thoth = fakeThoth();
        await init();
        const message = await listOrders.invoke({
            type: "tool_call",
            id: "call-1",
            name: "list_orders",
            args: { account: "A-2" },
        });
        expect(ran).toEqual(["list_orders:A-2"]);
        expect(thoth.checks[0].tool_args).toEqual({ account: "A-2" });
        expect(message.tool_call_id).toBe("call-1");
    });
    it("never runs a refused LangChain tool", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        await init();
        await expect(wireFunds.invoke({ amount: 1000000 })).rejects.toBeInstanceOf(ThothPolicyViolation);
        expect(ran).toEqual([]);
    });
    it("checks a string tool as { input }", async () => {
        const thoth = fakeThoth();
        await init();
        expect(await echo.invoke("hello")).toBe("hello");
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "echo",
            tool_args: { input: "hello" },
        });
    });
    it("checks an MCP client created before init(), and never sends a refused call", async () => {
        const client = await mcpClient();
        const thoth = fakeThoth();
        await init();
        await client.callTool({
            name: "create_order",
            arguments: { account: "B-1" },
        });
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "create_order",
            tool_args: { account: "B-1" },
        });
        thoth.decisions.create_order = "BLOCK";
        ran.length = 0;
        await expect(client.callTool({ name: "create_order", arguments: { account: "B-2" } })).rejects.toBeInstanceOf(ThothPolicyViolation);
        expect(ran).toEqual([]);
    });
    it("checks an MCP call a framework tool already checked once, under a prefixed name", async () => {
        const client = await mcpClient();
        const thoth = fakeThoth();
        await init();
        const adapter = tool(async (args) => {
            const result = await client.callTool({
                name: "create_order",
                arguments: args,
            });
            return JSON.stringify(result);
        }, {
            name: "brokerage_create_order",
            description: "Create an order (MCP)",
            schema: z.object({ account: z.string() }),
        });
        await adapter.invoke({ account: "C-1" });
        expect(thoth.checks.map((check) => check.tool_name)).toEqual([
            "brokerage_create_order",
        ]);
        expect(ran).toEqual(["create_order:C-1"]);
    });
    it("checks any other MCP call inside a checked tool", async () => {
        const client = await mcpClient();
        const thoth = fakeThoth();
        await init();
        const summarize = tool(async (args) => {
            await client.callTool({ name: "create_order", arguments: args });
            return "done";
        }, {
            name: "summarize",
            description: "Another tool with the same arguments",
            schema: z.object({ account: z.string() }),
        });
        await summarize.invoke({ account: "C-2" });
        expect(thoth.checks.map((check) => check.tool_name)).toEqual([
            "summarize",
            "create_order",
        ]);
    });
    it("shares a named session's history for the same user only", async () => {
        const thoth = fakeThoth();
        await init();
        await actingFor("alice@acme.test", () => listOrders.invoke({ account: "D" }), {
            sessionId: "conv-1",
        });
        await actingFor("alice@acme.test", () => echo.invoke("next"), {
            sessionId: "conv-1",
        });
        await actingFor("bob@acme.test", () => echo.invoke("next"), {
            sessionId: "conv-1",
        });
        await actingFor("alice@acme.test", () => echo.invoke("next"));
        const [first, second, bob, fresh] = thoth.checks;
        // The ID Thoth sees is derived per user, never the caller's ID itself,
        // so two users naming the same session never share one in Thoth.
        expect(first.session_id).toBe(SHARED_VECTOR);
        expect(second.session_id).toBe(SHARED_VECTOR);
        expect(bob.session_id).not.toBe(first.session_id);
        expect(bob.session_id).not.toBe("conv-1");
        // A check's history includes the call being checked.
        expect(second.session_tool_calls).toEqual(["list_orders", "echo"]);
        expect(bob.session_tool_calls).toEqual(["echo"]);
        expect(fresh.session_tool_calls).toEqual(["echo"]);
        expect(fresh.session_id).not.toBe(first.session_id);
    });
    it("derives the same named session ID as the Python SDK", () => {
        expect(namedSessionId({ tenantId: "acme", agentId: "trader" }, "alice@acme.test", "conv-1")).toBe(SHARED_VECTOR);
        expect(namedSessionId({ tenantId: "other", agentId: "trader" }, "alice@acme.test", "conv-1")).not.toBe(SHARED_VECTOR);
    });
    it("restores the frameworks on shutdown", async () => {
        const client = await mcpClient();
        const thoth = fakeThoth();
        await init();
        shutdown();
        await listOrders.invoke({ account: "E" });
        await client.callTool({
            name: "create_order",
            arguments: { account: "E" },
        });
        expect(thoth.checks).toEqual([]);
        expect(ran).toEqual(["list_orders:E", "create_order:E"]);
    });
});
//# sourceMappingURL=auto.test.js.map