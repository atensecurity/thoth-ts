import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph, } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { governLangChainTools } from "../integrations/langchain.js";
import { ThothPolicyViolation } from "../models.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";
const config = {
    agentId: "trader",
    tenantId: "acme",
    apiUrl,
    approvedScope: [],
    userId: "alice@acme.test",
};
function tools(ran) {
    return [
        tool(async ({ account }) => {
            ran.push(`list_orders:${account}`);
            return `orders for ${account}`;
        }, {
            name: "list_orders",
            description: "List open orders for an account",
            schema: z.object({ account: z.string() }),
        }),
        tool(async ({ amount }) => {
            ran.push(`wire_funds:${amount}`);
            return "sent";
        }, {
            name: "wire_funds",
            description: "Send a wire",
            schema: z.object({ amount: z.number() }),
        }),
    ];
}
function graphWith(governed, handleToolErrors = true) {
    return new StateGraph(MessagesAnnotation)
        .addNode("tools", new ToolNode(governed, { handleToolErrors }))
        .addEdge(START, "tools")
        .addEdge("tools", END)
        .compile();
}
/** Calls a tool from a mixed list (whose invoke types don't unify) directly. */
const invoke = (target, input) => target.invoke(input);
const calling = (name, args) => new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: "call-1", type: "tool_call" }],
});
afterEach(() => {
    vi.unstubAllGlobals();
});
describe("governLangChainTools", () => {
    it("checks a direct invoke with the tool's arguments", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const [listOrders] = governLangChainTools(tools(ran), config);
        expect(await invoke(listOrders, { account: "A-1" })).toBe("orders for A-1");
        expect(ran).toEqual(["list_orders:A-1"]);
        expect(thoth.checks[0]).toMatchObject({
            tool_name: "list_orders",
            tool_args: { account: "A-1" },
            user_id: "alice@acme.test",
        });
    });
    it("governs LangGraph's ToolNode, checking a ToolCall by its args", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const result = await graphWith(governLangChainTools(tools(ran), config)).invoke({ messages: [calling("list_orders", { account: "A-2" })] });
        expect(ran).toEqual(["list_orders:A-2"]);
        const reply = result.messages.at(-1);
        expect(reply.content).toBe("orders for A-2");
        expect(reply.tool_call_id).toBe("call-1");
        expect(thoth.checks[0].tool_args).toEqual({ account: "A-2" });
    });
    it("never runs a refused tool: the model is told, or the run stops", async () => {
        const thoth = fakeThoth();
        thoth.decisions.wire_funds = "BLOCK";
        const ran = [];
        const told = await graphWith(governLangChainTools(tools(ran), config)).invoke({ messages: [calling("wire_funds", { amount: 1e6 })] });
        const reply = told.messages.at(-1);
        expect(reply.status).toBe("error");
        expect(String(reply.content)).toContain("Thoth blocked tool 'wire_funds'");
        await expect(graphWith(governLangChainTools(tools(ran), config), false).invoke({
            messages: [calling("wire_funds", { amount: 1e6 })],
        })).rejects.toBeInstanceOf(ThothPolicyViolation);
        expect(ran).toEqual([]);
    });
    it("leaves the original tools alone and reports their schemas", async () => {
        const thoth = fakeThoth();
        const ran = [];
        const originals = tools(ran);
        const [governed] = governLangChainTools(originals, config);
        expect(governed.name).toBe("list_orders");
        await invoke(originals[0], { account: "raw" });
        expect(thoth.checks).toHaveLength(0);
        await vi.waitFor(() => expect(thoth.inventory).toHaveLength(1));
        expect(thoth.inventory[0].tools[0]).toMatchObject({
            name: "list_orders",
            input_schema: { type: "object", properties: { account: {} } },
        });
    });
});
//# sourceMappingURL=langchain.test.js.map