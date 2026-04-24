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

  it("maps authorization_decision aliases and modify payload fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_decision: "MODIFY",
            modification_reason: "path normalized",
            modified_tool_args: { path: "/tmp/safe.txt" },
          }),
      }),
    );

    const decision = await checkEnforce(
      buildConfig(),
      "read:data",
      "sess_1",
      ["read:data"],
    );

    expect(decision.decision).toBe("MODIFY");
    expect(decision.modificationReason).toBe("path normalized");
    expect(decision.modifiedToolArgs).toEqual({ path: "/tmp/safe.txt" });
  });

  it("maps decision metadata fields and receipt payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_decision: "BLOCK",
            decision_reason_code: "policy_scope_violation",
            action_classification: "write",
            reason: "blocked",
            receipt: { signature: "sig-xyz" },
          }),
      }),
    );

    const decision = await checkEnforce(
      buildConfig(),
      "write:file",
      "sess_1",
      ["write:file"],
    );

    expect(decision.decision).toBe("BLOCK");
    expect(decision.decisionReasonCode).toBe("policy_scope_violation");
    expect(decision.actionClassification).toBe("write");
    expect(decision.receipt).toEqual({ signature: "sig-xyz" });
  });

  it("sends default identity_binding when custom binding is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ decision: "ALLOW" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkEnforce(buildConfig(), "read:data", "sess_1", ["read:data"]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.identity_binding).toEqual({
      agent_id: "agent_1",
      tenant_id: "tenant_1",
      user_id: "system",
    });
  });
});
