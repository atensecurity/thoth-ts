import {
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { governAdkTools } from "../integrations/google-adk.js";
import { apiUrl, fakeThoth } from "./fake-thoth.js";

const config = {
  agentId: "trader",
  tenantId: "acme",
  apiUrl,
  approvedScope: [],
  userId: "alice@acme.test",
};

/** A model that calls one tool, then answers. */
class CallingModel extends BaseLlm {
  private step = 0;

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown>,
  ) {
    super({ model: "fake-model" });
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
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

  connect(): never {
    throw new Error("not live");
  }
}

/**
 * A FunctionTool built without inferring ADK's generic parameter types: with
 * this repo's Zod, that inference is excessively deep for tsc. Runtime
 * behaviour is ADK's own.
 */
function adkTool(
  name: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
): FunctionTool {
  const Tool = FunctionTool as unknown as new (options: object) => FunctionTool;
  return new Tool({ name, description, parameters, execute });
}

function tools(ran: string[]) {
  return [
    adkTool(
      "list_orders",
      "List open orders for an account",
      z.object({ account: z.string() }),
      async ({ account }) => {
        ran.push(`list_orders:${account}`);
        return { orders: [`order for ${account}`] };
      },
    ),
    adkTool(
      "wire_funds",
      "Send a wire",
      z.object({ amount: z.number() }),
      async ({ amount }) => {
        ran.push(`wire_funds:${amount}`);
        return { sent: true };
      },
    ),
  ];
}

async function runAgent(model: BaseLlm, governed: FunctionTool[]) {
  const agent = new LlmAgent({
    name: "trader",
    model,
    instruction: "Trade carefully.",
    tools: governed,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governAdkTools", () => {
  it("checks an ADK agent's tool call with its arguments before it runs", async () => {
    const thoth = fakeThoth();
    const ran: string[] = [];
    await runAgent(
      new CallingModel("list_orders", { account: "A-1" }),
      governAdkTools(tools(ran), config),
    );
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
    const ran: string[] = [];
    await runAgent(
      new CallingModel("wire_funds", { amount: 1e6 }),
      governAdkTools(tools(ran), config),
    ).catch(() => undefined);
    expect(ran).toEqual([]);
    expect(thoth.checks.map((check) => check.tool_name)).toEqual([
      "wire_funds",
    ]);
  });

  it("keeps each tool's fields and class, and leaves the originals alone", () => {
    fakeThoth();
    const originals = tools([]);
    const [governed] = governAdkTools(originals, config);
    expect(governed.name).toBe("list_orders");
    expect(governed).toBeInstanceOf(FunctionTool);
    expect(governed.runAsync).not.toBe(originals[0].runAsync);
  });
});
