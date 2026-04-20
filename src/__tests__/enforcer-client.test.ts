import { describe, it, expect, vi } from "vitest";
import {
  awaitStepUpDecision,
  checkEnforce,
} from "../enforcer-client";
import { EnforcementMode } from "../models";

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent_1",
    approvedScope: ["read:data"],
    tenantId: "tenant_1",
    userId: "system",
    enforcement: EnforcementMode.PROGRESSIVE,
    apiKey: "thoth_test_key",
    apiUrl: "https://enforce.trantor.atensecurity.com",
    stepUpTimeoutMinutes: 1,
    stepUpPollIntervalMs: 1,
    environment: "prod",
    ...overrides,
  } as any;
}

describe("enforcer-client response mapping", () => {
  it("maps snake_case enforce response fields to SDK shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "STEP_UP",
            hold_token: "tok_123",
            violation_id: "vio_123",
            reason: "requires approval",
          }),
      }),
    );

    const decision = await checkEnforce(
      buildConfig(),
      "read:data",
      "sess_1",
      ["read:data"],
    );

    expect(decision.decision).toBe("STEP_UP");
    expect(decision.holdToken).toBe("tok_123");
    expect(decision.violationId).toBe("vio_123");
    expect(decision.reason).toBe("requires approval");
  });

  it("resolves hold-status payload into ALLOW decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            resolved: true,
            resolution: "ALLOW",
          }),
      }),
    );

    const decision = await awaitStepUpDecision(buildConfig(), "tok_123");
    expect(decision.decision).toBe("ALLOW");
  });
});
