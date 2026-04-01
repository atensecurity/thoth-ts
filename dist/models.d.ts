export declare enum EnforcementMode {
    OBSERVE = "observe",
    STEP_UP = "step_up",
    BLOCK = "block",
    PROGRESSIVE = "progressive"
}
export declare enum SourceType {
    AGENT_TOOL_CALL = "agent_tool_call",
    AGENT_LLM_INVOCATION = "agent_llm_invocation"
}
export declare enum EventType {
    TOOL_CALL_PRE = "TOOL_CALL_PRE",
    TOOL_CALL_POST = "TOOL_CALL_POST",
    LLM_INVOCATION = "LLM_INVOCATION"
}
export declare enum DecisionType {
    ALLOW = "ALLOW",
    BLOCK = "BLOCK",
    STEP_UP = "STEP_UP"
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
export declare class ThothPolicyViolation extends Error {
    readonly toolName: string;
    readonly reason: string;
    readonly violationId?: string | undefined;
    constructor(toolName: string, reason: string, violationId?: string | undefined);
}
//# sourceMappingURL=models.d.ts.map