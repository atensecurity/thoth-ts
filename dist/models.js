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
    EventType["LLM_INVOCATION"] = "LLM_INVOCATION";
})(EventType || (EventType = {}));
export var DecisionType;
(function (DecisionType) {
    DecisionType["ALLOW"] = "ALLOW";
    DecisionType["BLOCK"] = "BLOCK";
    DecisionType["STEP_UP"] = "STEP_UP";
})(DecisionType || (DecisionType = {}));
export class ThothPolicyViolation extends Error {
    constructor(toolName, reason, violationId) {
        super(`Thoth blocked tool '${toolName}': ${reason}`);
        this.toolName = toolName;
        this.reason = reason;
        this.violationId = violationId;
        this.name = "ThothPolicyViolation";
    }
}
//# sourceMappingURL=models.js.map