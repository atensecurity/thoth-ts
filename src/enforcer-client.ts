import { EnforcementDecision, DecisionType, ThothConfig } from "./models";

const HOSTED_API_URL = "https://api.aten.security";
const FALLBACK: EnforcementDecision = { decision: DecisionType.ALLOW };

export async function checkEnforce(
  config: Required<ThothConfig>,
  toolName: string,
  sessionId: string,
  sessionToolCalls: string[],
): Promise<EnforcementDecision> {
  const enforcerUrl = config.apiKey ? HOSTED_API_URL : "http://enforcer:8080";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  try {
    const resp = await fetch(`${enforcerUrl}/v1/enforce`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: config.agentId,
        tenant_id: config.tenantId,
        tool_name: toolName,
        session_id: sessionId,
        session_tool_calls: sessionToolCalls,
        approved_scope: config.approvedScope,
        enforcement_mode: config.enforcement,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return FALLBACK;
    return (await resp.json()) as EnforcementDecision;
  } catch {
    return FALLBACK; // non-fatal
  }
}
