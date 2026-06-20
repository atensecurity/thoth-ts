import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { awaitStepUpDecision, checkEnforce } from "../enforcer-client";
import { EnforcementMode } from "../models";
function buildConfig(overrides = {}) {
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
        failOpen: false,
        ...overrides,
    };
}
function loadGoldenFixture(name) {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const fixturePath = join(testDir, "../../../../../testdata/sdk/enforcement_decision_golden.json");
    const parsed = JSON.parse(readFileSync(fixturePath, "utf-8"));
    return parsed[name];
}
describe("enforcer-client response mapping", () => {
    it("maps snake_case enforce response fields to SDK shape", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                decision: "STEP_UP",
                hold_token: "tok_123",
                violation_id: "vio_123",
                reason: "requires approval",
            }),
        }));
        const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
            "read:data",
        ]);
        expect(decision.decision).toBe("STEP_UP");
        expect(decision.holdToken).toBe("tok_123");
        expect(decision.violationId).toBe("vio_123");
        expect(decision.reason).toBe("requires approval");
    });
    it("resolves hold-status payload into ALLOW decision", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                resolved: true,
                resolution: "ALLOW",
            }),
        }));
        const decision = await awaitStepUpDecision(buildConfig(), "tok_123");
        expect(decision.decision).toBe("ALLOW");
    });
    it("maps authorization_decision aliases and modify payload fields", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                authorization_decision: "MODIFY",
                modification_reason: "path normalized",
                modified_tool_args: { path: "/tmp/safe.txt" },
            }),
        }));
        const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
            "read:data",
        ]);
        expect(decision.decision).toBe("MODIFY");
        expect(decision.modificationReason).toBe("path normalized");
        expect(decision.modifiedToolArgs).toEqual({ path: "/tmp/safe.txt" });
    });
    it("maps decision metadata fields and receipt payload", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                authorization_decision: "BLOCK",
                decision_reason_code: "policy_scope_violation",
                action_classification: "write",
                reason: "blocked",
                receipt: { signature: "sig-xyz" },
            }),
        }));
        const decision = await checkEnforce(buildConfig(), "write:file", "sess_1", [
            "write:file",
        ]);
        expect(decision.decision).toBe("BLOCK");
        expect(decision.decisionReasonCode).toBe("policy_scope_violation");
        expect(decision.actionClassification).toBe("write");
        expect(decision.receipt).toEqual({ signature: "sig-xyz" });
    });
    it("maps expanded decision telemetry and policy context fields", async () => {
        const golden = loadGoldenFixture("block_full_context");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(golden),
        }));
        const decision = await checkEnforce(buildConfig(), "write:file", "sess_1", [
            "write:file",
        ]);
        expect(decision.riskScore).toBe(93.7);
        expect(decision.latencyMs).toBe(15.4);
        expect(decision.packId).toBe("security-engineering");
        expect(decision.packVersion).toBe("2026.05.01");
        expect(decision.ruleVersion).toBe(7);
        expect(decision.regulatoryRegimes).toEqual(["soc2", "hipaa"]);
        expect(decision.matchedRuleIds).toEqual(["rule-openclaw-001"]);
        expect(decision.matchedControlIds).toEqual(["cc6.1", "cc7.2"]);
        expect(decision.policyReferences).toEqual(["SOC2 CC6.1", "SOC2 CC7.2"]);
        expect(decision.modelSignals).toEqual([
            "moses_action:block",
            "classification:write",
        ]);
    });
    it("sends default identity_binding when custom binding is not provided", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        await checkEnforce(buildConfig(), "read:data", "sess_1", ["read:data"]);
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(String(init.body));
        expect(body.identity_binding).toEqual({
            agent_id: "agent_1",
            tenant_id: "tenant_1",
            user_id: "system",
        });
    });
    it("allows on retryable status when failOpen is enabled", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
        }));
        const decision = await checkEnforce(buildConfig({ failOpen: true }), "read:data", "sess_1", ["read:data"]);
        expect(decision.decision).toBe("ALLOW");
        expect(decision.reason).toContain("status=503");
    });
    it("allows on transport failure when failOpen is enabled", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
        const decision = await checkEnforce(buildConfig({ failOpen: true }), "read:data", "sess_1", ["read:data"]);
        expect(decision.decision).toBe("ALLOW");
        expect(decision.reason).toContain("fail-open");
    });
    it("still blocks auth failures in failOpen mode", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
        }));
        const decision = await checkEnforce(buildConfig({ failOpen: true }), "read:data", "sess_1", ["read:data"]);
        expect(decision.decision).toBe("BLOCK");
    });
});
//# sourceMappingURL=enforcer-client.test.js.map