import { EventType } from "./models.js";
// Telemetry is a separate data product from authorization. Do not apply this
// projection to checkEnforce/requestHumanExplanation or to tool inputs/outputs.
const CONTENT = {
    [EventType.LLM_INVOCATION]: "thoth_sdk_session_start",
    [EventType.TOOL_CALL_PRE]: "tool invocation requested",
    [EventType.TOOL_CALL_POST]: "tool invocation completed",
    [EventType.TOOL_CALL_BLOCK]: "tool invocation blocked",
};
const STRING_FIELDS = [
    "sdk_language", "environment", "enforcement_trace_id", "action_attestation_id",
    "decision_id", "event_phase", "authorization_decision", "decision_reason_code",
    "action_classification", "pack_id", "pack_version", "result_type",
];
const NUMBER_FIELDS = [
    "duration_ms", "result_size_bytes", "risk_score", "latency_ms", "rule_version",
    "defer_timeout_seconds", "step_up_timeout_seconds",
];
const ID_LIST_FIELDS = ["regulatory_regimes", "matched_rule_ids", "matched_control_ids"];
function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
}
// Only known categorical/count signals are telemetry. Unknown signals may
// contain excerpts. This is a vocabulary check, not a PHI/secret detector.
const RISK_CATEGORIES = new Set([
    "prompt_injection", "sensitive_information_disclosure", "supply_chain",
    "data_model_poisoning", "improper_output_handling", "excessive_agency",
    "system_prompt_leakage", "vector_embedding_weaknesses", "misinformation",
    "unbounded_consumption",
]);
const FIXED_SIGNALS = new Set([
    "threat:prompt_injection", "fastml:unavailable", "moses_sync:unavailable",
    "moses_schema_guardrail:triggered", "attestation:present", "attestation:missing",
    "attestation:proof_complete", "attestation:proof_incomplete",
    "probabilistic_verifier:enabled",
]);
function securitySignal(value) {
    if (FIXED_SIGNALS.has(value))
        return true;
    if (/^(?:moses_action|authz):(allow|block|step_up|modify|defer)$/.test(value))
        return true;
    if (/^classification:(read|write|delete|execute|phi|pii|public|internal|confidential|restricted)$/.test(value))
        return true;
    if (/^(?:dlp_redactions|delegation_chain_len|defer_depth|retrieval_filter_fields):\d+$/.test(value))
        return true;
    if (/^attestation_policy_(?:enabled|required):(?:true|false)$/.test(value))
        return true;
    const parts = value.split(":");
    const confidence = (score) => score !== undefined && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(score);
    if (parts[0] === "threat" && parts.length === 3) {
        return ["prompt_injection_pattern", "tool_output_poisoning"].includes(parts[1]) && confidence(parts[2]);
    }
    if (["moses_risk", "moses_risk_classification"].includes(parts[0])) {
        return parts.length === 2 && RISK_CATEGORIES.has(parts[1]);
    }
    if (parts[0] === "moses_risk_conf") {
        return parts.length === 3 && RISK_CATEGORIES.has(parts[1]) && confidence(parts[2]);
    }
    return ["moses_confidence", "probabilistic_verifier_upper_bound"].includes(parts[0]) &&
        parts.length === 2 && confidence(parts[1]);
}
/** Allowlisted wire representation. Identifiers and policy codes must be opaque,
 * non-sensitive values supplied by the application/enforcer (see PRIVACY.md).
 * Never spread untrusted metadata or nested objects into the serialized event.
 */
export function telemetryEvent(event) {
    const source = event.metadata ?? {};
    const metadata = { telemetry_capture: "minimal" };
    for (const key of STRING_FIELDS) {
        if (typeof source[key] === "string")
            metadata[key] = source[key];
    }
    for (const key of NUMBER_FIELDS) {
        if (typeof source[key] === "number" && Number.isFinite(source[key]))
            metadata[key] = source[key];
    }
    for (const key of ID_LIST_FIELDS) {
        const list = stringList(source[key]);
        if (list)
            metadata[key] = list;
    }
    const signals = stringList(source.model_signals);
    if (signals)
        metadata.model_signals = signals.filter(securitySignal);
    // Retain correlation to the full receipt without exporting its arbitrary body.
    const receipt = source.receipt;
    if (receipt && typeof receipt === "object" && "decision_id" in receipt && typeof receipt.decision_id === "string") {
        metadata.decision_id = receipt.decision_id;
    }
    if (event.toolName)
        metadata.tool_call = { name: event.toolName };
    return {
        eventId: event.eventId,
        tenantId: event.tenantId,
        agentId: event.agentId,
        sessionId: event.sessionId,
        toolName: event.toolName,
        violationId: event.violationId,
        userId: event.userId,
        sourceType: event.sourceType,
        eventType: event.eventType,
        content: CONTENT[event.eventType],
        approvedScope: stringList(event.approvedScope) ?? [],
        enforcementMode: event.enforcementMode,
        sessionToolCalls: stringList(event.sessionToolCalls) ?? [],
        occurredAt: event.occurredAt,
        metadata,
    };
}
//# sourceMappingURL=telemetry.js.map