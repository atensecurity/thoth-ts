import { DecisionType } from "./models";
const FALLBACK = { decision: DecisionType.ALLOW };
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
        return (await resp.json());
    }
    catch {
        return FALLBACK; // non-fatal
    }
}
//# sourceMappingURL=enforcer-client.js.map