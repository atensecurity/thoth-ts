import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  awaitStepUpDecision,
  checkEnforce,
  hasNonFiniteNumber,
  requestHumanExplanation,
} from "../enforcer-client.js";
import { EnforcementMode } from "../models.js";

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
    failOpen: false,
    ...overrides,
  } as any;
}

function loadGoldenFixture(name: string): Record<string, unknown> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const fixtureRelativePath = "testdata/sdk/enforcement_decision_golden.json";
  let current = testDir;
  let fixturePath: string | null = null;

  for (let i = 0; i < 10; i += 1) {
    const candidate = join(current, fixtureRelativePath);
    if (existsSync(candidate)) {
      fixturePath = candidate;
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (!fixturePath) {
    throw new Error(
      `unable to locate golden fixture (${fixtureRelativePath}) from ${testDir}`,
    );
  }

  const parsed = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
  return parsed[name];
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

    const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
      "read:data",
    ]);

    expect(decision.decision).toBe("STEP_UP");
    expect(decision.holdToken).toBe("tok_123");
    expect(decision.violationId).toBe("vio_123");
    expect(decision.reason).toBe("requires approval");
  });

  it("waits on the hold when a deferred action is held for review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "STEP_UP",
            authorization_decision: "DEFER",
            hold_token: "tok_defer",
          }),
      }),
    );

    const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
      "read:data",
    ]);

    expect(decision.decision).toBe("STEP_UP");
    expect(decision.authorizationDecision).toBe("DEFER");
    expect(decision.holdToken).toBe("tok_defer");
  });

  it("still treats a DEFER without a hold as a deferral", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "STEP_UP",
            authorization_decision: "DEFER",
          }),
      }),
    );

    const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
      "read:data",
    ]);

    expect(decision.decision).toBe("DEFER");
  });

  it("carries the receipts and tells the operator where to approve", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            resolved: false,
            tool_name: "email.send",
            approval_url: "https://app.example/approvals/ap_1",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            resolved: true,
            resolution: "ALLOW",
            initial_receipt: { decision_id: "d1" },
            terminal_receipt: { decision_id: "d2" },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await awaitStepUpDecision(buildConfig(), "tok_123");

    expect(decision.decision).toBe("ALLOW");
    expect(decision.receipt).toEqual({ decision_id: "d1" });
    expect(decision.terminalReceipt).toEqual({ decision_id: "d2" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("https://app.example/approvals/ap_1"),
    );
    warn.mockRestore();
  });

  it("keeps the profile and declaration fields the enforcer returns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            decision: "ALLOW",
            profile_id: "finance",
            profile_version: "3",
            tenant_declarations_status: "declared",
            risk_classification: { tier: "high" },
          }),
      }),
    );

    const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
      "read:data",
    ]);

    expect(decision.profileId).toBe("finance");
    expect(decision.profileVersion).toBe("3");
    expect(decision.tenantDeclarationsStatus).toBe("declared");
    expect(decision.riskClassification).toEqual({ tier: "high" });
  });

  it("sends the key in both auth headers on enforce and on the hold poll", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ decision: "ALLOW" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ resolved: true, resolution: "ALLOW" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const config = { ...buildConfig(), apiKey: "key-123" };

    await checkEnforce(config, "read:data", "sess_1", ["read:data"]);
    await awaitStepUpDecision(config, "tok_1");

    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["X-Api-Key"]).toBe("key-123");
      expect(headers["Authorization"]).toBe("Bearer key-123");
    }
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

  it("continues polling an explicitly unresolved hold", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            resolved: false,
            resolution: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            resolved: true,
            resolution: "ALLOW",
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await awaitStepUpDecision(
      buildConfig({ stepUpPollIntervalMs: 1 }),
      "tok_pending",
    );

    expect(decision.decision).toBe("ALLOW");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    const decision = await checkEnforce(buildConfig(), "read:data", "sess_1", [
      "read:data",
    ]);

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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(golden),
      }),
    );

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

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.identity_binding).toEqual({
      agent_id: "agent_1",
      tenant_id: "tenant_1",
      user_id: "system",
    });
  });

  it("sends action_attestation_id when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ decision: "ALLOW" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkEnforce(
      buildConfig(),
      "read:data",
      "sess_1",
      ["read:data"],
      { path: "/tmp/a.txt" },
      "trace-1",
      "attest-1",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.enforcement_trace_id).toBe("trace-1");
    expect(body.action_attestation_id).toBe("attest-1");
  });

  it.each(
    [false, true].flatMap((failOpen) =>
      [
        "policy_backend_unavailable",
        "tenant_compliance_backend_unavailable",
      ].map((reasonCode) => ({ failOpen, reasonCode })),
    ),
  )(
    "preserves HTTP 200 BLOCK for $reasonCode with failOpen=$failOpen",
    async ({ failOpen, reasonCode }) => {
      const payload = {
        decision: "BLOCK",
        authorization_decision: "DENY",
        decision_reason_code: reasonCode,
        reason: `${reasonCode}: retry after backend recovery`,
      };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const decision = await checkEnforce(
        buildConfig({ failOpen }),
        "read:data",
        "sess_1",
        ["read:data"],
      );

      expect(decision.decision).toBe("BLOCK");
      expect(decision.authorizationDecision).toBe("DENY");
      expect(decision.decisionReasonCode).toBe(reasonCode);
      expect(decision.reason).toBe(payload.reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("allows on retryable status when failOpen is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }),
    );

    const decision = await checkEnforce(
      buildConfig({ failOpen: true }),
      "read:data",
      "sess_1",
      ["read:data"],
    );

    expect(decision.decision).toBe("ALLOW");
    expect(decision.reason).toContain("status=503");
  });

  it("allows on transport failure when failOpen is enabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const decision = await checkEnforce(
      buildConfig({ failOpen: true }),
      "read:data",
      "sess_1",
      ["read:data"],
    );

    expect(decision.decision).toBe("ALLOW");
    expect(decision.reason).toContain("fail-open");
  });

  it("still blocks auth failures in failOpen mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }),
    );

    const decision = await checkEnforce(
      buildConfig({ failOpen: true }),
      "read:data",
      "sess_1",
      ["read:data"],
    );

    expect(decision.decision).toBe("BLOCK");
  });

  it.each([false, true])(
    "blocks an oversized request locally without sending it (failOpen=%s)",
    async (failOpen) => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("EPIPE"));
      vi.stubGlobal("fetch", fetchMock);

      const decision = await checkEnforce(
        buildConfig({ failOpen }),
        "read:data",
        "sess_1",
        ["read:data"],
        { blob: "a".repeat(5 * 1024 * 1024) },
      );

      expect(decision.decision).toBe("BLOCK");
      expect(decision.reason).toContain("enforcer_request_too_large");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "blocks a 413 request_too_large with failOpen=%s",
    async (failOpen) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 413,
        }),
      );

      const decision = await checkEnforce(
        buildConfig({ failOpen }),
        "read:data",
        "sess_1",
        ["read:data"],
      );

      expect(decision.decision).toBe("BLOCK");
    },
  );

  describe.each([false, true])(
    "an enforcer reply that cannot be understood (failOpen=%s)",
    (failOpen) => {
      it.each([
        [
          "an unknown decision with a wrong-typed field",
          '{"decision":"MAYBE","risk_score":"high"}',
        ],
        ["an HTML page", "<html><body>Welcome</body></html>"],
        ["an empty array", "[]"],
        ["null", "null"],
        ["an empty body", ""],
        ["truncated JSON", '{"decision":"ALL'],
        ["an object without a decision", "{}"],
      ])("blocks %s", async (_name, body) => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
        );
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
        );

        expect(decision.decision).toBe("BLOCK");
        expect(decision.reason).toBe("enforcer response not understood");
        const logged = JSON.stringify([
          ...errSpy.mock.calls,
          ...warnSpy.mock.calls,
        ]);
        expect(logged).not.toContain("Welcome");
        expect(logged).not.toContain("MAYBE");
        expect(logged).not.toContain("fail-open");
        errSpy.mockRestore();
        warnSpy.mockRestore();
      });

      it("keeps a wrong-typed optional field on a valid BLOCK", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response('{"decision":"BLOCK","risk_score":"high"}', {
              status: 200,
            }),
          ),
        );
        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
        );
        expect(decision.decision).toBe("BLOCK");
      });

      it("names the status when a request is rejected", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue({ ok: false, status: 422 }),
        );
        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
        );
        expect(decision.decision).toBe("BLOCK");
        expect(decision.reason).toBe("enforcer rejected request (status=422)");
      });
    },
  );

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a timeout",
      () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
    ],
    ["a 503", () => Promise.resolve({ ok: false, status: 503 })],
    ["a 429", () => Promise.resolve({ ok: false, status: 429 })],
    [
      "a body read that times out",
      () =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.reject(
              new DOMException("The operation timed out.", "TimeoutError"),
            ),
        }),
    ],
  ])("still allows %s when failOpen is enabled", async (_name, respond) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(respond));
    const decision = await checkEnforce(
      buildConfig({ failOpen: true }),
      "read:data",
      "sess_1",
      ["read:data"],
    );
    expect(decision.decision).toBe("ALLOW");
    expect(decision.reason).toContain("fail-open");
  });

  describe.each([false, true])(
    "non-finite numbers in tool arguments (failOpen=%s)",
    (failOpen) => {
      it.each([
        ["NaN at the top level", { amount: Number.NaN }],
        ["Infinity at the top level", { amount: Infinity }],
        ["-Infinity at the top level", { amount: -Infinity }],
        ["NaN nested", { a: { b: { c: Number.NaN } } }],
        ["Infinity in an array", { list: [1, 2, Infinity] }],
        ["-Infinity in a nested array", { a: [[{ b: -Infinity }]] }],
      ])("blocks %s without sending", async (_name, toolArgs) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(
            new Response('{"decision":"ALLOW"}', { status: 200 }),
          );
        vi.stubGlobal("fetch", fetchMock);
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
          toolArgs,
        );

        expect(decision.decision).toBe("BLOCK");
        expect(decision.reason).toBe("request could not be built");
        expect(fetchMock).not.toHaveBeenCalled();
        const logged = JSON.stringify(errSpy.mock.calls);
        expect(logged).not.toContain("Infinity");
        expect(logged).not.toContain("NaN");
        errSpy.mockRestore();
      });

      it("leaves finite numbers and null alone", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(
            new Response('{"decision":"ALLOW"}', { status: 200 }),
          );
        vi.stubGlobal("fetch", fetchMock);
        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
          { a: 0, b: -1.5, c: null, d: [1, null, 2e300] },
        );
        expect(decision.decision).toBe("ALLOW");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    },
  );

  describe.each([false, true])(
    "a reply with a wrong-typed known field (failOpen=%s)",
    (failOpen) => {
      it.each([
        ["risk_score as a string", '{"decision":"ALLOW","risk_score":"high"}'],
        ["latency_ms as a string", '{"decision":"ALLOW","latency_ms":"5"}'],
        ["reason as a number", '{"decision":"ALLOW","reason":7}'],
        [
          "matched_rule_ids as a string",
          '{"decision":"ALLOW","matched_rule_ids":"r1"}',
        ],
        [
          "matched_rule_ids with a number",
          '{"decision":"ALLOW","matched_rule_ids":["r1",2]}',
        ],
        ["receipt as a string", '{"decision":"ALLOW","receipt":"x"}'],
        [
          "modified_tool_args as an array",
          '{"decision":"MODIFY","modified_tool_args":[]}',
        ],
        [
          "top_contributors as an object",
          '{"decision":"ALLOW","top_contributors":{}}',
        ],
        [
          "step_up_timeout_seconds as a string",
          '{"decision":"STEP_UP","step_up_timeout_seconds":"30"}',
        ],
      ])("blocks %s", async (_name, body) => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
        );
        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
        );
        expect(decision.decision).toBe("BLOCK");
        expect(decision.reason).toBe("enforcer response not understood");
      });

      it("accepts an unknown extra field and null optionals", async () => {
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValue(
              new Response(
                '{"decision":"ALLOW","risk_score":0.2,"reason":null,"future_field":{"x":[1]},"matched_rule_ids":["r1"]}',
                { status: 200 },
              ),
            ),
        );
        const decision = await checkEnforce(
          buildConfig({ failOpen }),
          "read:data",
          "sess_1",
          ["read:data"],
        );
        expect(decision.decision).toBe("ALLOW");
        expect(decision.riskScore).toBe(0.2);
        expect(decision.matchedRuleIds).toEqual(["r1"]);
      });
    },
  );

  it.each([false, true])(
    "blocks NaN at depth 10000 without sending (failOpen=%s)",
    async (failOpen) => {
      let node: Record<string, unknown> = { leaf: Number.NaN };
      for (let i = 0; i < 10000; i += 1) node = { next: node };
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const decision = await checkEnforce(
        buildConfig({ failOpen }),
        "read:data",
        "sess_1",
        ["read:data"],
        node,
      );
      expect(decision.reason).toBe("request could not be built");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("treats a tree larger than the walk limit as unbuildable, not as clean", () => {
    const tree = { a: [1, 2, 3], b: { c: 4 } };
    expect(hasNonFiniteNumber(tree)).toBe(false);
    expect(hasNonFiniteNumber(tree, 3)).toBe(true);
  });

  it("accepts null for an optional number field but not for the decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '{"decision":"ALLOW","risk_score":null,"latency_ms":null,"step_up_timeout_seconds":null}',
          { status: 200 },
        ),
      ),
    );
    const ok = await checkEnforce(
      buildConfig({ failOpen: false }),
      "read:data",
      "sess_1",
      ["read:data"],
    );
    expect(ok.decision).toBe("ALLOW");
    expect(ok.riskScore).toBeUndefined();
    expect(ok.latencyMs).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '{"decision":"ALLOW","receipt":null,"terminal_receipt":null,"modified_tool_args":null,"top_contributors":null}',
          { status: 200 },
        ),
      ),
    );
    const nullObjects = await checkEnforce(
      buildConfig({ failOpen: false }),
      "read:data",
      "sess_1",
      ["read:data"],
    );
    expect(nullObjects.decision).toBe("ALLOW");
    expect(nullObjects.receipt).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"decision":null,"risk_score":0.1}', { status: 200 }),
        ),
    );
    const bad = await checkEnforce(
      buildConfig({ failOpen: true }),
      "read:data",
      "sess_1",
      ["read:data"],
    );
    expect(bad.decision).toBe("BLOCK");
    expect(bad.reason).toBe("enforcer response not understood");
  });

  it("names the status on a 5xx with fail-open off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const decision = await checkEnforce(
      buildConfig({ failOpen: false }),
      "read:data",
      "sess_1",
      ["read:data"],
    );
    expect(decision.decision).toBe("BLOCK");
    expect(decision.reason).toBe("enforcer unavailable (status=503)");
  });

  it("requests a human explanation for BLOCK decisions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            violation_id: "vio-1",
            what_happened: "Your agent attempted a blocked action.",
            why_it_was_blocked: "Outside approved scope.",
            what_to_do_next: "Contact #secops.",
            business_impact: "Potential data loss.",
            severity: "high",
          }),
      }),
    );

    const explanation = await requestHumanExplanation(
      buildConfig(),
      {
        decision: "BLOCK",
        violationId: "vio-1",
        decisionReasonCode: "policy_scope_violation",
      } as any,
      "write:file",
      "sess_1",
      ["write:file"],
      { path: "/tmp/prod.db" },
    );

    expect(explanation?.violation_id).toBe("vio-1");
    expect(explanation?.what_to_do_next).toContain("#secops");
  });
});
