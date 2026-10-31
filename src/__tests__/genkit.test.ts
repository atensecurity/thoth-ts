import { generateMiddleware, genkit, z } from "genkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { thothGenkitMiddleware } from "../integrations/genkit.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";

const config = {
  agentId: "trader",
  tenantId: "acme",
  apiUrl,
  approvedScope: [],
  userId: "alice@acme.test",
};

/** A Genkit instance with a model that calls one tool, then answers. */
function setup(
  toolName: string,
  input: Record<string, unknown>,
  ran: string[],
) {
  const ai = genkit({});
  let step = 0;
  const model = ai.defineModel({ name: "calling-model" }, async () =>
    step++ === 0
      ? {
          message: {
            role: "model",
            content: [
              { toolRequest: { name: toolName, ref: "call-1", input } },
            ],
          },
          finishReason: "stop",
        }
      : {
          message: { role: "model", content: [{ text: "done" }] },
          finishReason: "stop",
        },
  );
  const listOrders = ai.defineTool(
    {
      name: "list_orders",
      description: "List open orders for an account",
      inputSchema: z.object({ account: z.string() }),
    },
    async ({ account }) => {
      ran.push(`list_orders:${account}`);
      return `orders for ${account}`;
    },
  );
  const wireFunds = ai.defineTool(
    {
      name: "wire_funds",
      description: "Send a wire",
      inputSchema: z.object({ amount: z.number() }),
    },
    async ({ amount }) => {
      ran.push(`wire_funds:${amount}`);
      return "sent";
    },
  );
  return { ai, model, tools: [listOrders, wireFunds] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thothGenkitMiddleware", () => {
  it("checks each tool call with its input before it runs", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    const { ai, model, tools } = setup("list_orders", { account: "A-1" }, ran);
    const response = await ai.generate({
      model,
      prompt: "What's open on A-1?",
      tools,
      use: [thothGenkitMiddleware(generateMiddleware, config)()],
    });
    expect(response.text).toBe("done");
    expect(ran).toEqual(["list_orders:A-1"]);
    expect(thoth.checks).toHaveLength(1);
    expect(thoth.checks[0]).toMatchObject({
      tool_name: "list_orders",
      tool_args: { account: "A-1" },
      user_id: "alice@acme.test",
    });
  });

  it("last in `use`, it checks the input the tool actually gets", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    const { ai, model, tools } = setup("list_orders", { account: "A-1" }, ran);
    // Middleware earlier in `use` rewrites the input before Thoth sees it.
    const rewrite = generateMiddleware({ name: "rewrite" }, () => ({
      tool: (req, ctx, next) =>
        next(
          {
            ...req,
            toolRequest: { ...req.toolRequest, input: { account: "B-2" } },
          },
          ctx,
        ),
    }));
    await ai.generate({
      model,
      prompt: "What's open?",
      tools,
      use: [rewrite(), thothGenkitMiddleware(generateMiddleware, config)()],
    });
    expect(thoth.checks[0].tool_args).toEqual({ account: "B-2" });
    expect(ran).toEqual(["list_orders:B-2"]);
  });

  it("never runs a refused tool, and the model is told", async () => {
    const thoth = fakeThoth();
    thoth.decisions.wire_funds = "BLOCK";
    const ran: string[] = [];
    const { ai, model, tools } = setup("wire_funds", { amount: 1e6 }, ran);
    const response = await ai.generate({
      model,
      prompt: "Send it",
      tools,
      use: [thothGenkitMiddleware(generateMiddleware, config)()],
    });
    expect(ran).toEqual([]);
    expect(response.text).toBe("done");
    const refusal = response.messages
      .flatMap((message) => message.content)
      .find((part) => part.toolResponse);
    expect(String(refusal?.toolResponse?.output)).toContain(
      "Thoth refused this call",
    );
  });
});
