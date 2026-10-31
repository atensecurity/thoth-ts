import { BaseLlm, BaseTool, FunctionTool, InMemoryRunner, LlmAgent, } from "@google/adk";
import { Agent, tool } from "@strands-agents/sdk";
import { VercelModel } from "@strands-agents/sdk/models/vercel";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { actingFor, init, shutdown } from "../auto.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";
const ran = [];
const timeline = [];
beforeEach(() => {
    ran.length = 0;
    timeline.length = 0;
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
// --- Strands ------------------------------------------------------------------
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
function strandsModel(toolName, input) {
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
    const provider = new MockLanguageModelV3({
        doStream: async () => ({
            stream: simulateReadableStream({ chunks: chunks() }),
        }),
    });
    return new VercelModel({ provider });
}
// Defined at import time, before init(), as agents usually are.
const listOrders = tool({
    name: "list_orders",
    description: "List open orders for an account",
    inputSchema: z.object({ account: z.string() }),
    callback: ({ account }) => {
        ran.push(`list_orders:${account}`);
        return `orders for ${account}`;
    },
});
const wireFunds = tool({
    name: "wire_funds",
    description: "Send a wire",
    inputSchema: z.object({ amount: z.number() }),
    callback: ({ amount }) => {
        ran.push(`wire_funds:${amount}`);
        return "sent";
    },
});
const ticker = tool({
    name: "ticker",
    description: "Stream prices",
    inputSchema: z.object({ symbol: z.string() }),
    callback: async function* ({ symbol }) {
        timeline.push("tool:start");
        yield `${symbol} 1`;
        yield `${symbol} 2`;
        timeline.push("tool:end");
        return `${symbol} closed`;
    },
});
function toolResults(agent) {
    const results = [];
    for (const message of agent.messages) {
        for (const block of message.content) {
            if (block.type === "toolResultBlock") {
                results.push({
                    status: block.status,
                    text: (block.content ?? []).map((part) => part.text ?? "").join(" "),
                });
            }
        }
    }
    return results;
}
describe("init() with Strands", () => {
    it("checks an agent-loop tool call for the actingFor user", async () => {
        const thoth = fakeThoth();
        expect(await init()).toContain("strands");
        const agent = new Agent({
            model: strandsModel("list_orders", { account: "A-1" }),
            tools: [listOrders, wireFunds],
            printer: false,
        });
        await actingFor("alice@acme.test", () => agent.invoke("What's open?"));
        expect(ran).toEqual(["list_orders:A-1"]);
        expect(thoth.checks).toHaveLength(1);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "list_orders",
            tool_args: { account: "A-1" },
            user_id: "alice@acme.test",
        });
    });
    it("never runs a refused call and tells the model why", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        await init();
        const agent = new Agent({
            model: strandsModel("wire_funds", { amount: 1e6 }),
            tools: [wireFunds],
            printer: false,
        });
        await agent.invoke("Send it");
        expect(ran).toEqual([]);
        const [result] = toolResults(agent);
        expect(result.status).toBe("error");
        expect(result.text).toMatch(/^Thoth refused this call/);
    });
    it("governs direct agent.tool calls", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        await init();
        const agent = new Agent({
            model: strandsModel("wire_funds", {}),
            tools: [wireFunds],
            printer: false,
        });
        const result = (await agent.tool.wire_funds.invoke({ amount: 5 }));
        expect(ran).toEqual([]);
        expect(result.status).toBe("error");
        expect(result.content?.[0]?.text).toMatch(/^Thoth refused this call/);
        expect(thoth.checks.map((check) => check.tool_name)).toEqual([
            "wire_funds",
        ]);
    });
    it("runs a streaming tool inside the check, still streaming", async () => {
        const thoth = fakeThoth();
        await init();
        const agent = new Agent({
            model: strandsModel("ticker", { symbol: "ACME" }),
            tools: [ticker],
            printer: false,
        });
        for await (const event of agent.stream("go")) {
            if (event.type === "toolStreamUpdateEvent")
                timeline.push("consumer:got");
        }
        expect(thoth.checks.map((check) => check.tool_name)).toEqual(["ticker"]);
        // Events reach the consumer while the tool is still running.
        expect(timeline.indexOf("consumer:got")).toBeGreaterThan(timeline.indexOf("tool:start"));
        expect(timeline.indexOf("consumer:got")).toBeLessThan(timeline.indexOf("tool:end"));
    });
    it("leaves Strands as it was after shutdown", async () => {
        const thoth = fakeThoth();
        await init();
        shutdown();
        const agent = new Agent({
            model: strandsModel("list_orders", { account: "Z" }),
            tools: [listOrders],
            printer: false,
        });
        await agent.invoke("go");
        await agent.tool.list_orders.invoke({ account: "Y" });
        expect(thoth.checks).toEqual([]);
        expect(ran).toEqual(["list_orders:Z", "list_orders:Y"]);
    });
});
// --- Google ADK ----------------------------------------------------------------
/** A model that calls one tool, then answers. */
class CallingModel extends BaseLlm {
    constructor(toolName, args) {
        super({ model: "fake-model" });
        this.toolName = toolName;
        this.args = args;
        this.step = 0;
    }
    async *generateContentAsync() {
        if (this.step++ === 0) {
            yield {
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                id: "call-1",
                                name: this.toolName,
                                args: this.args,
                            },
                        },
                    ],
                },
            };
            return;
        }
        yield { content: { role: "model", parts: [{ text: "done" }] } };
    }
    connect() {
        throw new Error("not live");
    }
}
/** A FunctionTool built without ADK's deep generic inference (tsc runs out of memory on it). */
function adkTool(name, parameters, execute) {
    const Tool = FunctionTool;
    return new Tool({ name, description: name, parameters, execute });
}
const adkListOrders = adkTool("list_orders", z.object({ account: z.string() }), async ({ account }) => {
    ran.push(`list_orders:${String(account)}`);
    return { orders: [`order for ${String(account)}`] };
});
const adkWireFunds = adkTool("wire_funds", z.object({ amount: z.number() }), async ({ amount }) => {
    ran.push(`wire_funds:${String(amount)}`);
    return { sent: true };
});
/** A tool class of the app's own, with its own runAsync. */
class Shout extends BaseTool {
    constructor() {
        super({ name: "shout", description: "Shout a message" });
    }
    _getDeclaration() {
        return {
            name: "shout",
            description: "Shout a message",
            parametersJsonSchema: {
                type: "object",
                properties: { text: { type: "string" } },
            },
        };
    }
    async runAsync(request) {
        ran.push(`shout:${String(request.args.text)}`);
        return { shouted: true };
    }
}
async function runAdk(model, tools) {
    const agent = new LlmAgent({
        name: "trader",
        model,
        instruction: "Trade carefully.",
        tools,
    });
    const runner = new InMemoryRunner({ agent, appName: "thoth-test" });
    const session = await runner.sessionService.createSession({
        appName: "thoth-test",
        userId: "alice",
    });
    const events = [];
    for await (const event of runner.runAsync({
        userId: "alice",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
        events.push(event);
    }
    return events;
}
describe("init() with Google ADK", () => {
    it("checks a tool defined before init(), for the actingFor user", async () => {
        const thoth = fakeThoth();
        expect(await init()).toContain("google_adk");
        await actingFor("alice@acme.test", () => runAdk(new CallingModel("list_orders", { account: "B-1" }), [
            adkListOrders,
            adkWireFunds,
        ]));
        expect(ran).toEqual(["list_orders:B-1"]);
        expect(thoth.checks).toHaveLength(1);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "list_orders",
            tool_args: { account: "B-1" },
            user_id: "alice@acme.test",
        });
    });
    it("never runs a refused tool", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        await init();
        await runAdk(new CallingModel("wire_funds", { amount: 1e6 }), [
            adkWireFunds,
        ]).catch(() => undefined);
        expect(ran).toEqual([]);
        expect(thoth.checks.map((check) => check.tool_name)).toEqual([
            "wire_funds",
        ]);
    });
    it("governs the app's own tool classes", async () => {
        const thoth = fakeThoth();
        thoth.decisions.shout = "BLOCK";
        await init();
        await runAdk(new CallingModel("shout", { text: "hi" }), [
            new Shout(),
        ]).catch(() => undefined);
        expect(ran).toEqual([]);
        expect(thoth.checks.map((check) => check.tool_name)).toEqual(["shout"]);
    });
    it("leaves ADK tools as they were after shutdown", async () => {
        const thoth = fakeThoth();
        await init();
        await runAdk(new CallingModel("list_orders", { account: "C" }), [
            adkListOrders,
        ]);
        shutdown();
        thoth.checks.length = 0;
        ran.length = 0;
        await runAdk(new CallingModel("list_orders", { account: "D" }), [
            adkListOrders,
        ]);
        expect(thoth.checks).toEqual([]);
        expect(ran).toEqual(["list_orders:D"]);
    });
});
//# sourceMappingURL=auto-adk-strands.test.js.map