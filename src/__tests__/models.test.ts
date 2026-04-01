import { describe, it, expect } from "vitest";
import {
  BehavioralEvent,
  ThothConfig,
  EnforcementDecision,
  EnforcementMode,
  DecisionType,
  SourceType,
  EventType,
} from "../models";

describe("BehavioralEvent", () => {
  it("has required fields", () => {
    const event: BehavioralEvent = {
      eventId: "evt_123",
      tenantId: "trantor",
      sessionId: "sess_abc",
      userId: "user_xyz",
      agentId: "invoice-processor",
      sourceType: SourceType.AGENT_TOOL_CALL,
      eventType: EventType.TOOL_CALL_PRE,
      content: "read:invoices",
      approvedScope: ["read:invoices"],
      enforcementMode: EnforcementMode.PROGRESSIVE,
      sessionToolCalls: [],
      occurredAt: new Date(),
    };
    expect(event.tenantId).toBe("trantor");
  });
});

describe("EnforcementDecision", () => {
  it("identifies allow decision", () => {
    const d: EnforcementDecision = { decision: DecisionType.ALLOW };
    expect(d.decision).toBe("ALLOW");
  });

  it("identifies block decision", () => {
    const d: EnforcementDecision = {
      decision: DecisionType.BLOCK,
      reason: "out of scope",
    };
    expect(d.decision).toBe("BLOCK");
    expect(d.reason).toBe("out of scope");
  });
});
