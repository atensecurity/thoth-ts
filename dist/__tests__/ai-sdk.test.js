import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { governAiSdkTools } from "../integrations/ai-sdk.js";
import { ThothPolicyViolation } from "../models.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";
const config = {
    agentId: "trader",
    tenantId: "acme",
    apiUrl,
    approvedScope: ["listOrders", "wireFunds"],
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
        listOrders: tool({
            description: "List open orders for an account",
            inputSchema: z.object({ account: z.string() }),
            execute: async ({ account }, { toolCallId }) => {
                ran.push(`listOrders:${account}:${toolCallId}`);
                return `orders for ${account}`;
            },
        }),
        wireFunds: tool({
            description: "Send a wire transfer",
            inputSchema: z.object({ amount: z.number() }),
            execute: async ({ amount }) => {
                ran.push(`wireFunds:${amount}`);
                return "sent";
            },
        }),
    };
}
afterEach(() => {
    vi.unstubAllGlobals();
});
describe("governAiSdkTools", () => {
    it("checks a tool call with only its input, and runs it when allowed", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const result = await generateText({
            model: modelCalling("listOrders", { account: "A-1" }),
            tools: governAiSdkTools(tools(ran), config),
            stopWhen: stepCountIs(3),
            prompt: "What's open on A-1?",
        });
        expect(ran).toEqual(["listOrders:A-1:call-1"]);
        expect(result.steps[0].toolResults[0].output).toBe("orders for A-1");
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
        const result = await generateText({
            model: modelCalling("wireFunds", { amount: 1000000 }),
            tools: governAiSdkTools(tools(ran), config),
            stopWhen: stepCountIs(3),
            prompt: "Send it",
        });
        expect(ran).toEqual([]);
        const error = result.steps[0].content.find((part) => part.type === "tool-error");
        expect(error && "error" in error ? error.error : undefined).toBeInstanceOf(ThothPolicyViolation);
    });
    it("leaves tools without execute alone and reports schemas as JSON Schema", async () => {
        const thoth = fakeThoth();
        const clientSide = {
            description: "Ask the user",
            inputSchema: z.object({ q: z.string() }),
        };
        const governed = governAiSdkTools({ ...tools([]), askUser: clientSide }, config);
        expect(governed.askUser).toBe(clientSide);
        await vi.waitFor(() => expect(thoth.inventory).toHaveLength(1));
        const reported = thoth.inventory[0].tools;
        expect(reported.map((item) => item.name)).toEqual([
            "listOrders",
            "wireFunds",
        ]);
        expect(reported[0].input_schema).toMatchObject({
            type: "object",
            properties: { account: { type: "string" } },
        });
    });
});
//# sourceMappingURL=ai-sdk.test.js.map