export enum EnforcementMode {
  OBSERVE = "observe",
  STEP_UP = "step_up",
  BLOCK = "block",
  PROGRESSIVE = "progressive",
}

export enum SourceType {
  AGENT_TOOL_CALL = "agent_tool_call",
  AGENT_LLM_INVOCATION = "agent_llm_invocation",
}

export enum EventType {
  TOOL_CALL_PRE = "TOOL_CALL_PRE",
  TOOL_CALL_POST = "TOOL_CALL_POST",
  LLM_INVOCATION = "LLM_INVOCATION",
}

export enum DecisionType {
  ALLOW = "ALLOW",
  BLOCK = "BLOCK",
  STEP_UP = "STEP_UP",
}

export interface BehavioralEvent {
  eventId: string;
  tenantId: string;
  agentId?: string;
  sessionId: string;
  toolName?: string;
  userId: string;
  sourceType: SourceType;
  eventType: EventType;
  content: string;
  metadata?: Record<string, unknown>;
  approvedScope: string[];
  enforcementMode: EnforcementMode;
  sessionToolCalls: string[];
  occurredAt: Date;
}

export interface ThothConfig {
  agentId: string;
  approvedScope: string[];
  tenantId: string;
  userId?: string;
  enforcement?: EnforcementMode;
  apiKey?: string;
  stepUpTimeoutMinutes?: number;
  stepUpPollIntervalMs?: number;
}

export interface EnforcementDecision {
  decision: DecisionType;
  reason?: string;
  violationId?: string;
  holdToken?: string;
}

export class ThothPolicyViolation extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
    public readonly violationId?: string,
  ) {
    super(`Thoth blocked tool '${toolName}': ${reason}`);
    this.name = "ThothPolicyViolation";
  }
}
