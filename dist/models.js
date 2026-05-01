export var EnforcementMode;
(function (EnforcementMode) {
    EnforcementMode["OBSERVE"] = "observe";
    EnforcementMode["STEP_UP"] = "step_up";
    EnforcementMode["BLOCK"] = "block";
    EnforcementMode["PROGRESSIVE"] = "progressive";
})(EnforcementMode || (EnforcementMode = {}));
export var SourceType;
(function (SourceType) {
    SourceType["AGENT_TOOL_CALL"] = "agent_tool_call";
    SourceType["AGENT_LLM_INVOCATION"] = "agent_llm_invocation";
})(SourceType || (SourceType = {}));
export var EventType;
(function (EventType) {
    EventType["TOOL_CALL_PRE"] = "TOOL_CALL_PRE";
    EventType["TOOL_CALL_POST"] = "TOOL_CALL_POST";
    EventType["TOOL_CALL_BLOCK"] = "TOOL_CALL_BLOCK";
    EventType["LLM_INVOCATION"] = "LLM_INVOCATION";
})(EventType || (EventType = {}));
export var DecisionType;
(function (DecisionType) {
    DecisionType["ALLOW"] = "ALLOW";
    DecisionType["BLOCK"] = "BLOCK";
    DecisionType["STEP_UP"] = "STEP_UP";
    DecisionType["MODIFY"] = "MODIFY";
    DecisionType["DEFER"] = "DEFER";
})(DecisionType || (DecisionType = {}));
export class ThothPolicyViolation extends Error {
    constructor(toolName, reason, violationId, options = {}) {
        super(`Thoth blocked tool '${toolName}': ${reason}`);
        this.toolName = toolName;
        this.reason = reason;
        this.violationId = violationId;
        this.name = "ThothPolicyViolation";
        this.decisionReasonCode = options.decisionReasonCode;
        this.actionClassification = options.actionClassification;
        this.authorizationDecision = options.authorizationDecision;
        this.deferTimeoutSeconds = options.deferTimeoutSeconds;
        this.stepUpTimeoutSeconds = options.stepUpTimeoutSeconds;
        this.riskScore = options.riskScore;
        this.latencyMs = options.latencyMs;
        this.packId = options.packId;
        this.packVersion = options.packVersion;
        this.ruleVersion = options.ruleVersion;
        this.regulatoryRegimes = options.regulatoryRegimes;
        this.matchedRuleIds = options.matchedRuleIds;
        this.matchedControlIds = options.matchedControlIds;
        this.policyReferences = options.policyReferences;
        this.modelSignals = options.modelSignals;
        this.receipt = options.receipt;
    }
}
//# sourceMappingURL=models.js.map