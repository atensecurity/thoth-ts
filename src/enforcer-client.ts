import { EnforcementDecision, DecisionType, ThothConfig } from "./models";

const FALLBACK: EnforcementDecision = { decision: DecisionType.ALLOW };

type EnforceConfig = Required<
  Pick<
    ThothConfig,
    | "agentId"
    | "approvedScope"
    | "tenantId"
    | "userId"
    | "enforcement"
    | "apiKey"
    | "apiUrl"
    | "stepUpTimeoutMinutes"
    | "stepUpPollIntervalMs"
  >
> &
  Pick<ThothConfig, "sessionIntent">;

export async function checkEnforce(
  config: EnforceConfig,
  toolName: string,
  sessionId: string,
  sessionToolCalls: string[],
): Promise<EnforcementDecision> {
  const managedApiUrl = config.apiUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
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
        tool_name: toolName,
        session_id: sessionId,
        session_tool_calls: sessionToolCalls,
        approved_scope: config.approvedScope,
        enforcement_mode: config.enforcement,
        ...(config.sessionIntent !== undefined && {
          session_intent: config.sessionIntent,
        }),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return FALLBACK;
    return (await resp.json()) as EnforcementDecision;
  } catch {
    return FALLBACK; // non-fatal
  }
}
