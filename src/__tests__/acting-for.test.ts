import { tool } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { actingFor, init, namedSessionId, shutdown } from "../auto.js";
import { governAiSdkTools } from "../integrations/ai-sdk.js";
import { governLangChainTools } from "../integrations/langchain.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";

const base = { agentId: "trader", tenantId: "acme", apiUrl, approvedScope: [] };
const ran: string[] = [];

const listOrders = tool(
  async ({ account }: { account: string }) => {
    ran.push(`list_orders:${account}`);
    return `orders for ${account}`;
  },
  {
    name: "list_orders",
    description: "List open orders for an account",
    schema: z.object({ account: z.string() }),
  },
);

/** An AI SDK tool set: plain objects, governed with governAiSdkTools. */
const aiTools = {
  wire_funds: {
    description: "Send a wire",
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }: { amount: number }, options?: unknown) => {
      void options;
      ran.push(`wire_funds:${amount}`);
      return "sent";
    },
  },
};

beforeEach(() => {
  ran.length = 0;
});

afterEach(() => {
  shutdown();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("actingFor with govern* functions", () => {
  it("checks a governed tool as the actingFor user, without init()", async () => {
    const thoth = fakeThoth();
    // Governed once at startup, with no userId.
    const [governed] = governLangChainTools([listOrders], base);
    await actingFor("alice@acme.test", () => governed.invoke({ account: "A" }));
    await actingFor("bob@acme.test", () => governed.invoke({ account: "B" }));
    expect(thoth.checks.map((check) => check.user_id)).toEqual([
      "alice@acme.test",
      "bob@acme.test",
    ]);
    expect(thoth.checks[0].session_id).not.toBe(thoth.checks[1].session_id);
  });

  it("keeps a userId set in the config", async () => {
    const thoth = fakeThoth();
    const [governed] = governLangChainTools([listOrders], {
      ...base,
      userId: "service@acme.test",
    });
    await actingFor("alice@acme.test", () => governed.invoke({ account: "A" }));
    expect(thoth.checks[0].user_id).toBe("service@acme.test");
  });

  it("runs every governed tool of one agent in one session per block", async () => {
    const thoth = fakeThoth();
    const [orders] = governLangChainTools([listOrders], base);
    const wires = governAiSdkTools(aiTools, base);
    await actingFor("alice@acme.test", async () => {
      await orders.invoke({ account: "A" });
      await wires.wire_funds.execute!({ amount: 5 }, {
        toolCallId: "call-1",
        messages: [],
      } as never);
    });
    const [first, second] = thoth.checks;
    expect(second.session_id).toBe(first.session_id);
    expect(second.session_tool_calls).toEqual(["list_orders", "wire_funds"]);
  });

  it("checks each tool with its own config, sharing only the session", async () => {
    const thoth = fakeThoth();
    // One agent, two tool sets governed with different configs. (Both
    // enforce: in observe mode a call isn't sent to the enforcer.)
    const [orders] = governLangChainTools([listOrders], {
      ...base,
      approvedScope: ["list_orders"],
      purpose: "reporting",
    });
    const wires = governAiSdkTools(aiTools, {
      ...base,
      approvedScope: [],
      purpose: "payments",
    });
    await actingFor("alice@acme.test", async () => {
      await orders.invoke({ account: "A" });
      await wires.wire_funds.execute!({ amount: 5 }, {
        toolCallId: "call-1",
        messages: [],
      } as never);
    });
    const [first, second] = thoth.checks as unknown as Record<
      string,
      unknown
    >[];
    // Each check carries its own tool set's config, never the other's.
    expect(first.tool_name).toBe("list_orders");
    expect(first.approved_scope).toEqual(["list_orders"]);
    expect(first.purpose).toBe("reporting");
    expect(second.tool_name).toBe("wire_funds");
    expect(second.approved_scope).toEqual([]);
    expect(second.purpose).toBe("payments");
    // The session and its history are still shared.
    expect(second.session_id).toBe(first.session_id);
    expect(second.session_tool_calls).toEqual(["list_orders", "wire_funds"]);
  });

  it("continues a named session across requests, per user", async () => {
    const thoth = fakeThoth();
    // A fresh governed copy per request, as an app might make.
    await actingFor(
      "alice@acme.test",
      () =>
        governLangChainTools([listOrders], base)[0].invoke({ account: "A" }),
      { sessionId: "conv-9" },
    );
    await actingFor(
      "alice@acme.test",
      () =>
        governAiSdkTools(aiTools, base).wire_funds.execute!({ amount: 1 }, {
          toolCallId: "call-2",
          messages: [],
        } as never),
      { sessionId: "conv-9" },
    );
    const [first, second] = thoth.checks;
    expect(first.session_id).toBe(
      namedSessionId(base, "alice@acme.test", "conv-9"),
    );
    expect(second.session_id).toBe(first.session_id);
    expect(second.session_tool_calls).toEqual(["list_orders", "wire_funds"]);
  });

  it("shares one session between init() and govern* tools in a block", async () => {
    vi.stubEnv("THOTH_AGENT_ID", "trader");
    vi.stubEnv("THOTH_TENANT_ID", "acme");
    vi.stubEnv("THOTH_API_URL", apiUrl);
    const thoth = fakeThoth();
    await init();
    const wires = governAiSdkTools(aiTools, base);
    await actingFor("alice@acme.test", async () => {
      await listOrders.invoke({ account: "A" }); // governed by init()
      await wires.wire_funds.execute!({ amount: 2 }, {
        toolCallId: "call-3",
        messages: [],
      } as never);
    });
    const [first, second] = thoth.checks;
    expect(first.user_id).toBe("alice@acme.test");
    expect(second.session_id).toBe(first.session_id);
    expect(second.session_tool_calls).toEqual(["list_orders", "wire_funds"]);
  });

  it("checks calls outside any block in the governed session, as before", async () => {
    const thoth = fakeThoth();
    const [governed] = governLangChainTools([listOrders], base);
    await governed.invoke({ account: "Z" });
    expect(thoth.checks[0].user_id).toBe("system");
  });
});
