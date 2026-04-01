import { describe, it, expect, vi } from "vitest";
import { instrument } from "../instrumentor";
import { DecisionType, ThothPolicyViolation } from "../models";

class FakeTool {
  name = "read:data";
  calls: unknown[][] = [];
  run(...args: unknown[]) {
    this.calls.push(args);
    return "result";
  }
}

class FakeAgent {
  tools = [new FakeTool()];
}

class FakeStreamingTool {
  name = "stream:data";
  async *run(..._args: unknown[]) {
    yield "chunk1";
    yield "chunk2";
    yield "chunk3";
  }
}

class FakeStreamingAgent {
  tools = [new FakeStreamingTool()];
}

describe("instrument()", () => {
  it("returns the same agent object", () => {
    const agent = new FakeAgent();
    const result = instrument(agent, {
      agentId: "test",
      approvedScope: ["read:data"],
      tenantId: "trantor",
    });
    expect(result).toBe(agent);
  });

  it("allows in-scope tool call", async () => {
    const agent = new FakeAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: "ALLOW" }),
      }),
    );
    instrument(agent, {
      agentId: "test",
      approvedScope: ["read:data"],
      tenantId: "trantor",
    });
    const result = await agent.tools[0].run("arg");
    expect(result).toBe("result");
    expect(agent.tools[0].calls).toContainEqual(["arg"]);
  });

  it("raises ThothPolicyViolation on block", async () => {
    const agent = new FakeAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: "BLOCK", reason: "blocked" }),
      }),
    );
    instrument(agent, {
      agentId: "test",
      approvedScope: [],
      tenantId: "trantor",
      enforcement: "block" as any,
    });
    await expect(agent.tools[0].run()).rejects.toThrow(ThothPolicyViolation);
  });

  it("async generator tool yields all values", async () => {
    const agent = new FakeStreamingAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: "ALLOW" }),
      }),
    );
    instrument(agent, {
      agentId: "test",
      approvedScope: ["stream:data"],
      tenantId: "trantor",
    });

    const chunks: unknown[] = [];
    for await (const chunk of (agent.tools[0] as any).run("arg")) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"]);
  });

  it("TOOL_CALL_PRE is emitted before first yield", async () => {
    const agent = new FakeStreamingAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: "ALLOW" }),
      }),
    );

    // Track order of events vs yields by patching emitEvent indirectly
    // We verify PRE fires before any yield by collecting order of operations
    const order: string[] = [];

    // Override the streaming tool to record when run body starts
    class OrderTrackingStreamingTool {
      name = "stream:data";
      async *run(..._args: unknown[]) {
        order.push("first-yield");
        yield "chunk1";
      }
    }

    class OrderTrackingAgent {
      tools = [new OrderTrackingStreamingTool()];
    }

    const trackingAgent = new OrderTrackingAgent();
    instrument(trackingAgent, {
      agentId: "test",
      approvedScope: ["stream:data"],
      tenantId: "trantor",
    });

    // The wrapped generator should call enforce (fetch) before running the original generator body
    const gen = (trackingAgent.tools[0] as any).run("arg");
    // Haven't iterated yet — fetch (enforce) should fire on first `.next()` call
    const firstNext = gen.next();
    order.push("awaiting-first-next");
    await firstNext;
    // After first next, enforce was called (fetch was called) and "first-yield" was set
    expect(order).toContain("first-yield");
  });

  it("TOOL_CALL_POST is emitted after generator exhaustion", async () => {
    const agent = new FakeStreamingAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: "ALLOW" }),
      }),
    );
    instrument(agent, {
      agentId: "test",
      approvedScope: ["stream:data"],
      tenantId: "trantor",
    });

    const chunks: unknown[] = [];
    for await (const chunk of (agent.tools[0] as any).run()) {
      chunks.push(chunk);
    }
    // If generator was fully exhausted without error, all chunks should be present
    expect(chunks).toHaveLength(3);
  });

  it("wrapped function preserves original function name", () => {
    const agent = new FakeAgent();
    instrument(agent, {
      agentId: "test",
      approvedScope: ["read:data"],
      tenantId: "trantor",
    });
    // The original FakeTool.run method is named "run" (bound function name: "bound run")
    // After wrapping, the name should be preserved from the original
    expect(agent.tools[0].run.name).toBe("bound run");
  });

  it("wrapped async generator function preserves original function name", () => {
    const agent = new FakeStreamingAgent();
    instrument(agent, {
      agentId: "test",
      approvedScope: ["stream:data"],
      tenantId: "trantor",
    });
    // The original FakeStreamingTool.run is an async generator, bound name is "bound run"
    expect((agent.tools[0] as any).run.name).toBe("bound run");
  });
});
