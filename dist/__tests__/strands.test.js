import { Agent, tool } from "@strands-agents/sdk";
import { VercelModel } from "@strands-agents/sdk/models/vercel";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { governStrandsTools } from "../integrations/strands.js";
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
/** A streamed model that calls one tool, then answers. */
function modelCalling(toolName, input) {
    let step = 0;
    const chunks = () => step++ === 0
        ? [
            { type: "stream-start", warnings: [] },
            {
                type: "tool-call",
                toolCallId: "call-1",
                toolName,
                input: JSON.stringify(input),
            },
            {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
            },
        ]
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
            },
        ];
    // Strands pins an older @ai-sdk/provider, so its LanguageModelV3 type is a
    // different copy of the same interface the mock implements.
    const provider = new MockLanguageModelV3({
        doStream: async () => ({
            stream: simulateReadableStream({ chunks: chunks() }),
        }),
    });
    return new VercelModel({ provider });
}
function tools(ran) {
    return [
        tool({
            name: "list_orders",
            description: "List open orders for an account",
            inputSchema: z.object({ account: z.string() }),
            callback: ({ account }) => {
                ran.push(`list_orders:${account}`);
                return `orders for ${account}`;
            },
        }),
        tool({
            name: "wire_funds",
            description: "Send a wire",
            inputSchema: z.object({ amount: z.number() }),
            callback: ({ amount }) => {
                ran.push(`wire_funds:${amount}`);
                return "sent";
            },
        }),
    ];
}
afterEach(() => {
    vi.unstubAllGlobals();
});
describe("governStrandsTools", () => {
    it("checks a Strands agent's tool call with its input before it runs", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const agent = new Agent({
            model: modelCalling("list_orders", { account: "A-1" }),
            tools: governStrandsTools(tools(ran), config),
            printer: false,
        });
        await agent.invoke("What's open on A-1?");
        expect(ran).toEqual(["list_orders:A-1"]);
        expect(thoth.checks).toHaveLength(1);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "list_orders",
            tool_args: { account: "A-1" },
            user_id: "alice@acme.test",
        });
    });
    it("never runs a refused tool", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        const ran = [];
        const agent = new Agent({
            model: modelCalling("wire_funds", { amount: 1e6 }),
            tools: governStrandsTools(tools(ran), config),
            printer: false,
        });
        await agent.invoke("Send it").catch(() => undefined);
        expect(ran).toEqual([]);
        expect(thoth.checks.map((check) => check.tool_name)).toEqual([
            "wire_funds",
        ]);
    });
    it("keeps each tool's fields and class, and leaves the originals alone", () => {
        fakeThoth();
        const originals = tools([]);
        const [governed] = governStrandsTools(originals, config);
        expect(governed.name).toBe("list_orders");
        expect(governed.toolSpec).toEqual(originals[0].toolSpec);
        expect(Object.getPrototypeOf(governed)).toBe(Object.getPrototypeOf(originals[0]));
        expect(governed.stream).not.toBe(originals[0].stream);
    });
});
//# sourceMappingURL=strands.test.js.map