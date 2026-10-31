import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { governMastraTools } from "../integrations/mastra.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";
const config = {
    agentId: "trader",
    tenantId: "acme",
    apiUrl,
    approvedScope: [],
    userId: "alice@acme.test",
};
const usage = {
    inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
};
/** A model that calls one tool, then answers. */
function modelCalling(toolName, input) {
    let step = 0;
    return new MockLanguageModelV4({
        doGenerate: async () => step++ === 0
            ? {
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-1",
                        toolName,
                        input: JSON.stringify(input),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
                warnings: [],
            }
            : {
                content: [{ type: "text", text: "done" }],
                finishReason: { unified: "stop", raw: undefined },
                usage,
                warnings: [],
            },
    });
}
function tools(ran) {
    return {
        listOrders: createTool({
            id: "list-orders",
            description: "List open orders for an account",
            inputSchema: z.object({ account: z.string() }),
            execute: async ({ account }) => {
                ran.push(`listOrders:${account}`);
                return { orders: [`order for ${account}`] };
            },
        }),
        wireFunds: createTool({
            id: "wire-funds",
            description: "Send a wire",
            inputSchema: z.object({ amount: z.number() }),
            execute: async ({ amount }) => {
                ran.push(`wireFunds:${amount}`);
                return { sent: true };
            },
        }),
    };
}
function agentWith(model, governed) {
    return new Agent({
        id: "trader",
        name: "trader",
        instructions: "Trade carefully.",
        model,
        tools: governed,
    });
}
afterEach(() => {
    vi.unstubAllGlobals();
});
describe("governMastraTools", () => {
    it("checks a Mastra agent's tool call with its input before it runs", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const agent = agentWith(modelCalling("listOrders", { account: "A-1" }), governMastraTools(tools(ran), config));
        await agent.generate("What's open on A-1?", { maxSteps: 3 });
        expect(ran).toEqual(["listOrders:A-1"]);
        expect(thoth.checks).toHaveLength(1);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "listOrders",
            tool_args: { account: "A-1" },
            user_id: "alice@acme.test",
        });
    });
    it("never runs a refused tool", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wireFunds = "BLOCK";
        const ran = [];
        const agent = agentWith(modelCalling("wireFunds", { amount: 1e6 }), governMastraTools(tools(ran), config));
        await agent.generate("Send it", { maxSteps: 3 }).catch(() => undefined);
        expect(ran).toEqual([]);
        expect(thoth.checks.map((check) => check.tool_name)).toEqual(["wireFunds"]);
    });
    it("keeps each tool's fields and class, and leaves the originals alone", () => {
        fakeThoth();
        const ran = [];
        const originals = tools(ran);
        const governed = governMastraTools(originals, config);
        expect(governed.listOrders.id).toBe("list-orders");
        expect(governed.listOrders.description).toBe("List open orders for an account");
        expect(Object.getPrototypeOf(governed.listOrders)).toBe(Object.getPrototypeOf(originals.listOrders));
        expect(governed.listOrders.execute).not.toBe(originals.listOrders.execute);
    });
});
//# sourceMappingURL=mastra.test.js.map