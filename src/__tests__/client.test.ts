import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnforcementMode } from "../models";

const mocks = vi.hoisted(() => ({
  instrument: vi.fn(<T extends object>(agent: T) => agent),
  wrapAnthropicTools: vi.fn((toolFns: Record<string, unknown>) => toolFns),
  wrapOpenAITools: vi.fn((toolFns: Record<string, unknown>) => toolFns),
}));

vi.mock("../instrumentor", () => ({
  instrument: mocks.instrument,
}));

vi.mock("../integrations/anthropic", () => ({
  wrapAnthropicTools: mocks.wrapAnthropicTools,
}));

vi.mock("../integrations/openai", () => ({
  wrapOpenAITools: mocks.wrapOpenAITools,
}));

import { ThothClient } from "../client";

describe("ThothClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates instrument() with merged defaults", () => {
    const agent = { tools: [] as unknown[] };
    const client = new ThothClient({
      tenantId: "acme",
      userId: "alice@acme.com",
    });

    const result = client.instrument(agent, {
      agentId: "agent-1",
      approvedScope: ["search_docs"],
    });

    expect(result).toBe(agent);
    expect(mocks.instrument).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({
        agentId: "agent-1",
        approvedScope: ["search_docs"],
        tenantId: "acme",
        userId: "alice@acme.com",
      }),
    );
  });

  it("wrap() is a legacy alias to instrument()", () => {
    const agent = { tools: [] as unknown[] };
    const client = new ThothClient({ tenantId: "acme" });

    client.wrap(agent, {
      agentId: "agent-2",
      approvedScope: ["read_file"],
    });

    expect(mocks.instrument).toHaveBeenCalledTimes(1);
    expect(mocks.instrument).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({
        agentId: "agent-2",
        approvedScope: ["read_file"],
        tenantId: "acme",
      }),
    );
  });

  it("delegates anthropic and openai wrappers with merged defaults", () => {
    const client = new ThothClient({
      tenantId: "acme",
      enforcement: EnforcementMode.BLOCK,
    });
    const toolFns = {
      search_docs: async (_input: Record<string, unknown>) => "ok",
    };

    client.instrumentAnthropic(toolFns, {
      agentId: "agent-3",
      approvedScope: ["search_docs"],
    });
    client.instrumentOpenAI(toolFns, {
      agentId: "agent-4",
      approvedScope: ["search_docs"],
    });

    expect(mocks.wrapAnthropicTools).toHaveBeenCalledWith(
      toolFns,
      expect.objectContaining({
        agentId: "agent-3",
        tenantId: "acme",
        enforcement: "block",
      }),
    );
    expect(mocks.wrapOpenAITools).toHaveBeenCalledWith(
      toolFns,
      expect.objectContaining({
        agentId: "agent-4",
        tenantId: "acme",
        enforcement: "block",
      }),
    );
  });

  it("legacy wrapper aliases delegate to instrument* helpers", () => {
    const client = new ThothClient({ tenantId: "acme" });
    const toolFns = {
      search_docs: async (_input: Record<string, unknown>) => "ok",
    };

    client.wrapAnthropicTools(toolFns, {
      agentId: "agent-5",
      approvedScope: ["search_docs"],
    });
    client.wrapOpenAITools(toolFns, {
      agentId: "agent-6",
      approvedScope: ["search_docs"],
    });

    expect(mocks.wrapAnthropicTools).toHaveBeenCalledTimes(1);
    expect(mocks.wrapOpenAITools).toHaveBeenCalledTimes(1);
  });

  it("is exported from the package root", async () => {
    const root = await import("../index");
    expect(root.ThothClient).toBe(ThothClient);
  });
});
