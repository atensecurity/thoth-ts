import { EnforcementDecision, DecisionType, ThothConfig } from "./models";

const FALLBACK: EnforcementDecision = {
  decision: DecisionType.BLOCK,
  reason: "enforcer unavailable",
};
const STEP_UP_TIMEOUT: EnforcementDecision = {
  decision: DecisionType.BLOCK,
  reason: "step-up auth timeout — no approver response",
};

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
    | "environment"
  >
> &
  Pick<
    ThothConfig,
    "sessionIntent" | "policyContext" | "enforcementTraceId"
  >;

export async function checkEnforce(
  config: EnforceConfig,
  toolName: string,
  sessionId: string,
  sessionToolCalls: string[],
  toolArgs?: Record<string, unknown>,
  enforcementTraceId?: string,
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
        user_id: config.userId,
        tool_name: toolName,
        session_id: sessionId,
        session_tool_calls: sessionToolCalls,
        approved_scope: config.approvedScope,
        enforcement_mode: config.enforcement,
        environment: config.environment,
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
    if (!resp.ok) return FALLBACK;
    return toEnforcementDecision(await resp.json());
  } catch {
    return FALLBACK; // non-fatal
  }
}

function parseDecision(value: unknown): DecisionType | null {
  if (value === DecisionType.ALLOW) return DecisionType.ALLOW;
  if (value === DecisionType.BLOCK) return DecisionType.BLOCK;
  if (value === DecisionType.STEP_UP) return DecisionType.STEP_UP;
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toEnforcementDecision(payload: unknown): EnforcementDecision {
  const record = readRecord(payload);
  const decision = parseDecision(record.decision);
  if (!decision) return FALLBACK;
  return {
    decision,
    reason: readText(record.reason),
    violationId: readText(record.violation_id ?? record.violationId),
    holdToken: readText(record.hold_token ?? record.holdToken),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function awaitStepUpDecision(
  config: EnforceConfig,
  holdToken: string,
): Promise<EnforcementDecision> {
  const managedApiUrl = config.apiUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  const deadline = Date.now() + config.stepUpTimeoutMinutes * 60 * 1000;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(
        `${managedApiUrl}/v1/enforce/hold/${encodeURIComponent(holdToken)}`,
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(6000),
        },
      );
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
    } catch {
      // non-fatal polling failure
    }

    await sleep(config.stepUpPollIntervalMs);
  }

  return STEP_UP_TIMEOUT;
}
