import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { openSession } from "../instrumentor.js";
import { governMcpClient } from "../integrations/mcp.js";
import { ThothPolicyViolation } from "../models.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";

const config = {
  agentId: "trader",
  tenantId: "acme",
  apiUrl,
  approvedScope: [],
  userId: "alice@acme.test",
};

/** A real MCP server with two tools, connected to a real client in memory. */
async function connected(ran: string[]) {
  const server = new McpServer({ name: "orders", version: "1.0.0" });
  server.registerTool(
    "list_orders",
    {
      description: "List open orders for an account",
      inputSchema: { account: z.string() },
    },
    async ({ account }) => {
      ran.push(`list_orders:${account}`);
      return { content: [{ type: "text", text: `orders for ${account}` }] };
    },
  );
  server.registerTool(
    "wire_funds",
    { description: "Send a wire", inputSchema: { amount: z.number() } },
    async ({ amount }) => {
      ran.push(`wire_funds:${amount}`);
      return { content: [{ type: "text", text: "sent" }] };
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = governMcpClient(
    new Client({ name: "trader", version: "1.0.0" }),
    config,
  );
  await client.connect(clientSide);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governMcpClient", () => {
  it("checks each tool call with its arguments, in one session", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    const client = await connected(ran);
    const result = await client.callTool({
      name: "list_orders",
      arguments: { account: "A-1" },
    });
    await client.callTool({
      name: "list_orders",
      arguments: { account: "A-2" },
    });
    expect(ran).toEqual(["list_orders:A-1", "list_orders:A-2"]);
    expect(result.content).toEqual([{ type: "text", text: "orders for A-1" }]);
    expect(thoth.checks).toHaveLength(2);
    expect(thoth.checks[0]).toMatchObject({
      tool_name: "list_orders",
      tool_args: { account: "A-1" },
      user_id: "alice@acme.test",
    });
    expect(thoth.checks[1].session_id).toBe(thoth.checks[0].session_id);
    expect(thoth.checks[1].session_tool_calls).toEqual(["list_orders"]);
  });

  it("never sends a refused call to the MCP server", async () => {
    const thoth = fakeThoth();
    thoth.decisions.wire_funds = "BLOCK";
    const ran: string[] = [];
    const client = await connected(ran);
    await expect(
      client.callTool({ name: "wire_funds", arguments: { amount: 1e6 } }),
    ).rejects.toBeInstanceOf(ThothPolicyViolation);
    expect(ran).toEqual([]);
  });

  it("reports listed tools to the inventory once, as JSON Schema", async () => {
    const thoth = fakeThoth();
    const client = await connected([]);
    await client.listTools();
    await client.listTools();
    await vi.waitFor(() => expect(thoth.inventory).toHaveLength(1));
    const reported = thoth.inventory[0].tools;
    expect(reported.map((tool) => tool.name)).toEqual([
      "list_orders",
      "wire_funds",
    ]);
    expect(reported[0].input_schema).toMatchObject({
      type: "object",
      properties: { account: { type: "string" } },
    });
  });

  it("doesn't check a call a governed wrapper already checked", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    const client = await connected(ran);
    const frameworkTool = openSession(config).wrap(
      "list_orders",
      (args: unknown) =>
        client.callTool({
          name: "list_orders",
          arguments: args as Record<string, unknown>,
        }),
    );
    await frameworkTool({ account: "A-3" });
    expect(ran).toEqual(["list_orders:A-3"]);
    expect(thoth.checks).toHaveLength(1);
  });
});
