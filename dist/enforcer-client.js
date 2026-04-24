import { DecisionType } from "./models";
const FALLBACK = {
    decision: DecisionType.BLOCK,
    reason: "enforcer unavailable",
};
const STEP_UP_TIMEOUT = {
    decision: DecisionType.BLOCK,
    reason: "step-up auth timeout — no approver response",
};
function defaultIdentityBinding(config) {
    if (config.identityBinding && Object.keys(config.identityBinding).length > 0) {
        return { ...config.identityBinding };
    }
    const binding = {
        agent_id: config.agentId,
        tenant_id: config.tenantId,
    };
    if (config.userId) {
        binding.user_id = config.userId;
    }
    return binding;
}
export async function checkEnforce(config, toolName, sessionId, sessionToolCalls, toolArgs, enforcementTraceId) {
    const managedApiUrl = config.apiUrl.replace(/\/$/, "");
    const headers = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    try {
        const resp = await fetch(`${managedApiUrl}/v1/enforce`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                agent_id: config.agentId,
                tenant_id: config.tenantId,
                user_id: config.userId,
                tool_name: toolName,
                session_id: sessionId,
                session_tool_calls: sessionToolCalls,
                approved_scope: config.approvedScope,
                enforcement_mode: config.enforcement,
                environment: config.environment,
                identity_binding: defaultIdentityBinding(config),
                ...(toolArgs !== undefined && { tool_args: toolArgs }),
                ...(config.policyContext !== undefined && {
                    metadata: { policy_context: config.policyContext },
                }),
                ...(enforcementTraceId !== undefined && {
                    enforcement_trace_id: enforcementTraceId,
                }),
                ...(config.sessionIntent !== undefined && {
                    session_intent: config.sessionIntent,
                }),
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok)
            return FALLBACK;
        return toEnforcementDecision(await resp.json());
    }
    catch {
        return FALLBACK; // non-fatal
    }
}
function parseDecision(value) {
    if (typeof value !== "string")
        return null;
    const key = value.trim().toUpperCase();
    if (key === DecisionType.ALLOW)
        return DecisionType.ALLOW;
    if (key === DecisionType.BLOCK || key === "DENY")
        return DecisionType.BLOCK;
    if (key === DecisionType.STEP_UP || key === "CHALLENGE" || key === "ESCALATE" || key === "REVIEW") {
        return DecisionType.STEP_UP;
    }
    if (key === DecisionType.MODIFY || key === "MODIFIED" || key === "TRANSFORM") {
        return DecisionType.MODIFY;
    }
    if (key === DecisionType.DEFER || key === "DEFERRED" || key === "HOLD") {
        return DecisionType.DEFER;
    }
    return null;
}
function readRecord(value) {
    return value !== null && typeof value === "object"
        ? value
        : {};
}
function readText(value) {
    return typeof value === "string" ? value : undefined;
}
function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function toEnforcementDecision(payload) {
    const record = readRecord(payload);
    const decision = parseDecision(record.authorization_decision ?? record.authorizationDecision ?? record.decision);
    if (!decision)
        return FALLBACK;
    return {
        decision,
        decisionReasonCode: readText(record.decision_reason_code ?? record.decisionReasonCode),
        actionClassification: readText(record.action_classification ?? record.actionClassification),
        reason: readText(record.reason) ??
            readText(record.defer_reason ?? record.deferReason) ??
            readText(record.modification_reason ?? record.modificationReason),
        violationId: readText(record.violation_id ?? record.violationId),
        holdToken: readText(record.hold_token ?? record.holdToken),
        receipt: record.receipt && typeof record.receipt === "object"
            ? record.receipt
            : undefined,
        modifiedToolArgs: record.modified_tool_args && typeof record.modified_tool_args === "object"
            ? record.modified_tool_args
            : record.modifiedToolArgs && typeof record.modifiedToolArgs === "object"
                ? record.modifiedToolArgs
                : undefined,
        modificationReason: readText(record.modification_reason ?? record.modificationReason),
        deferReason: readText(record.defer_reason ?? record.deferReason),
        deferTimeoutSeconds: readNumber(record.defer_timeout_seconds ?? record.deferTimeoutSeconds),
        stepUpTimeoutSeconds: readNumber(record.step_up_timeout_seconds ?? record.stepUpTimeoutSeconds),
    };
}
async function sleep(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
export async function awaitStepUpDecision(config, holdToken) {
    const managedApiUrl = config.apiUrl.replace(/\/$/, "");
    const headers = {};
    if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    const deadline = Date.now() + config.stepUpTimeoutMinutes * 60 * 1000;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`${managedApiUrl}/v1/enforce/hold/${encodeURIComponent(holdToken)}`, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(6000),
            });
            if (!resp.ok) {
                await sleep(config.stepUpPollIntervalMs);
                continue;
            }
            const payload = readRecord(await resp.json());
            const resolved = payload.resolved === true;
            const resolution = parseDecision(payload.resolution);
            if (resolved && resolution) {
                return {
                    decision: resolution,
                    reason: readText(payload.reason),
                    violationId: readText(payload.violation_id ?? payload.violationId),
                };
            }
            const directDecision = toEnforcementDecision(payload);
            if (directDecision.decision !== DecisionType.STEP_UP) {
                return directDecision;
            }
        }
        catch {
            // non-fatal polling failure
        }
        await sleep(config.stepUpPollIntervalMs);
    }
    return STEP_UP_TIMEOUT;
}
//# sourceMappingURL=enforcer-client.js.map