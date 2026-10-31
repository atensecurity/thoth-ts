import {
  Agent,
  type Model,
  type ModelResponse,
  run,
  setTracingDisabled,
  tool,
  Usage,
} from "@openai/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { governOpenAIAgentTools } from "../integrations/openai-agents.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";

const config = {
  agentId: "trader",
  tenantId: "acme",
  apiUrl,
  approvedScope: [],
  userId: "alice@acme.test",
};

/** A model that calls one function tool, then answers. */
function modelCalling(name: string, args: Record<string, unknown>): Model {
  let step = 0;
  const respond = (output: ModelResponse["output"]): ModelResponse => ({
    usage: new Usage(),
    output,
  });
  return {
    async getResponse() {
      return step++ === 0
        ? respond([
            {
              type: "function_call",
              callId: "call-1",
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            },
          ])
        : respond([
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done" }],
            },
          ]);
    },
    async *getStreamedResponse() {
      throw new Error("not streamed in tests");
    },
  };
}

function tools(ran: string[]) {
  return [
    tool({
      name: "list_orders",
      description: "List open orders for an account",
      parameters: z.object({ account: z.string() }),
      execute: async ({ account }) => {
        ran.push(`list_orders:${account}`);
        return `orders for ${account}`;
      },
    }),
    tool({
      name: "wire_funds",
      description: "Send a wire",
      parameters: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        ran.push(`wire_funds:${amount}`);
        return "sent";
      },
    }),
  ];
}

beforeAll(() => {
  setTracingDisabled(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governOpenAIAgentTools", () => {
  it("checks an agent's function call with its arguments before it runs", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    const agent = new Agent({
      name: "trader",
      instructions: "Trade carefully.",
      model: modelCalling("list_orders", { account: "A-1" }),
      tools: governOpenAIAgentTools(tools(ran), config),
    });
    const result = await run(agent, "What's open on A-1?");
    expect(result.finalOutput).toBe("done");
    expect(ran).toEqual(["list_orders:A-1"]);
    expect(thoth.checks).toHaveLength(1);
    expect(thoth.checks[0]).toMatchObject({
      tool_name: "list_orders",
      tool_args: { account: "A-1" },
      user_id: "alice@acme.test",
    });
  });

  it("never runs a refused tool, and the model is told", async () => {
    const thoth = fakeThoth();
    thoth.decisions.wire_funds = "BLOCK";
    const ran: string[] = [];
    const agent = new Agent({
      name: "trader",
      instructions: "Trade carefully.",
      model: modelCalling("wire_funds", { amount: 1e6 }),
      tools: governOpenAIAgentTools(tools(ran), config),
    });
    const result = await run(agent, "Send it");
    expect(ran).toEqual([]);
    expect(result.finalOutput).toBe("done");
    const output = result.newItems.find(
      (item) => item.type === "tool_call_output_item",
    );
    expect(JSON.stringify(output?.rawItem)).toContain(
      "Thoth refused this call",
    );
  });

  it("leaves the original tools alone and keeps each tool's fields", () => {
    fakeThoth();
    const originals = tools([]);
    const [governed] = governOpenAIAgentTools(originals, config);
    expect(governed.name).toBe("list_orders");
    expect(governed.type).toBe("function");
    expect(governed.invoke).not.toBe(originals[0].invoke);
  });
});
