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
    STEP_UP = "STEP_UP",
    MODIFY = "MODIFY",
    DEFER = "DEFER"
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
    /**
     * Tenant API base URL used for both behavioral event ingestion and policy checks.
     * Required directly or through THOTH_API_URL. Example:
     * https://enforce.<tenant>.<apex-domain>
     */
    apiUrl?: string;
    stepUpTimeoutMinutes?: number;
    stepUpPollIntervalMs?: number;
    /**
     * Declares the purpose of this session for HIPAA minimum-necessary enforcement.
     * When the active compliance pack defines session_scopes, tools outside the
     * declared intent scope are step-up-challenged even if they appear in approvedScope.
     * Example: "phi_eligibility_check"
     */
    sessionIntent?: string;
    /**
     * Optional tenant-defined policy context sent to the enforcer as
     * metadata.policy_context for tenant/role-aware pre-filters.
     */
    policyContext?: Record<string, unknown>;
    /**
     * Optional identity binding context for execution-time actor verification.
     * When omitted, the SDK sends a default binding with agent_id, tenant_id,
     * and user_id (when available).
     */
    identityBinding?: Record<string, unknown>;
    /**
     * Optional correlation identifier propagated through enforcer -> fastml -> deepllm.
     * Defaults to the instrumented session UUID when omitted.
     */
    enforcementTraceId?: string;
    /**
     * Environment tag used for env-scoped policy resolution ("dev", "prod", ...).
     * Defaults to "prod".
     */
    environment?: string;
}
export interface EnforcementDecision {
    decision: DecisionType;
    decisionReasonCode?: string;
    actionClassification?: string;
    reason?: string;
    violationId?: string;
    holdToken?: string;
    receipt?: Record<string, unknown>;
    modifiedToolArgs?: Record<string, unknown>;
    modificationReason?: string;
    deferReason?: string;
    deferTimeoutSeconds?: number;
    stepUpTimeoutSeconds?: number;
}
export declare class ThothPolicyViolation extends Error {
    readonly toolName: string;
    readonly reason: string;
    readonly violationId?: string | undefined;
    constructor(toolName: string, reason: string, violationId?: string | undefined);
}
//# sourceMappingURL=models.d.ts.map