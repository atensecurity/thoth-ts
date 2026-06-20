import { EnforcementDecision, DecisionType, ThothConfig } from "./models";

const FALLBACK: EnforcementDecision = {
  decision: DecisionType.BLOCK,
  reason: "enforcer unavailable",
};
const FAIL_OPEN_FALLBACK: EnforcementDecision = {
  decision: DecisionType.ALLOW,
  reason: "enforcer unavailable (fail-open)",
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
    | "failOpen"
  >
> &
  Pick<
    ThothConfig,
    | "sessionIntent"
    | "policyContext"
    | "enforcementTraceId"
    | "purpose"
    | "dataClassification"
    | "taskContext"
  > &
  Pick<ThothConfig, "identityBinding">;

function defaultIdentityBinding(
  config: Pick<
    ThothConfig,
    "agentId" | "tenantId" | "userId" | "identityBinding"
  >,
): Record<string, unknown> {
  if (
    config.identityBinding &&
    Object.keys(config.identityBinding).length > 0
  ) {
    return { ...config.identityBinding };
  }
  const binding: Record<string, unknown> = {
    agent_id: config.agentId,
    tenant_id: config.tenantId,
  };
  if (config.userId) {
    binding.user_id = config.userId;
  }
  return binding;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

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
        ...(config.purpose !== undefined && {
          purpose: config.purpose,
        }),
        ...(config.dataClassification !== undefined && {
          data_classification: config.dataClassification,
        }),
        ...(config.taskContext !== undefined && {
          task_context: config.taskContext,
        }),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      if (config.failOpen && isRetryableStatus(resp.status)) {
        console.warn(
          "thoth: enforcer returned retryable status=%s, fail-open fallback to ALLOW (tool=%s)",
          resp.status,
          toolName,
        );
        return {
          decision: DecisionType.ALLOW,
          reason: `enforcer unavailable (status=${resp.status}, fail-open)`,
        };
      }
      console.error(
        "thoth: enforcer returned non-2xx, fail-closed fallback to BLOCK (status=%s tool=%s)",
        resp.status,
        toolName,
      );
      return FALLBACK;
    }
    return toEnforcementDecision(await resp.json());
  } catch (error) {
    if (config.failOpen) {
      console.warn(
        "thoth: enforcer unreachable, fail-open fallback to ALLOW (tool=%s):",
        toolName,
        error,
      );
      return FAIL_OPEN_FALLBACK;
    }
    console.error(
      "thoth: enforcer unreachable, fail-closed fallback to BLOCK (tool=%s):",
      toolName,
      error,
    );
    return FALLBACK; // non-fatal
  }
}

function parseDecision(value: unknown): DecisionType | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  if (key === DecisionType.ALLOW) return DecisionType.ALLOW;
  if (key === DecisionType.BLOCK || key === "DENY") return DecisionType.BLOCK;
  if (
    key === DecisionType.STEP_UP ||
    key === "CHALLENGE" ||
    key === "ESCALATE" ||
    key === "REVIEW"
  ) {
    return DecisionType.STEP_UP;
  }
  if (
    key === DecisionType.MODIFY ||
    key === "MODIFIED" ||
    key === "TRANSFORM"
  ) {
    return DecisionType.MODIFY;
  }
  if (key === DecisionType.DEFER || key === "DEFERRED" || key === "HOLD") {
    return DecisionType.DEFER;
  }
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : [];
}

function toEnforcementDecision(payload: unknown): EnforcementDecision {
  const record = readRecord(payload);
  const decision = parseDecision(
    record.authorization_decision ??
      record.authorizationDecision ??
      record.decision,
  );
  if (!decision) return FALLBACK;
  return {
    decision,
    authorizationDecision: readText(
      record.authorization_decision ?? record.authorizationDecision,
    ),
    decisionReasonCode: readText(
      record.decision_reason_code ?? record.decisionReasonCode,
    ),
    actionClassification: readText(
      record.action_classification ?? record.actionClassification,
    ),
    reason:
      readText(record.reason) ??
      readText(record.defer_reason ?? record.deferReason) ??
      readText(record.modification_reason ?? record.modificationReason),
    violationId: readText(record.violation_id ?? record.violationId),
    holdToken: readText(record.hold_token ?? record.holdToken),
    riskScore: readNumber(record.risk_score ?? record.riskScore),
    latencyMs: readNumber(record.latency_ms ?? record.latencyMs),
    packId: readText(record.pack_id ?? record.packId),
    packVersion: readText(record.pack_version ?? record.packVersion),
    ruleVersion: readNumber(record.rule_version ?? record.ruleVersion),
    regulatoryRegimes: readStringArray(
      record.regulatory_regimes ?? record.regulatoryRegimes,
    ),
    matchedRuleIds: readStringArray(
      record.matched_rule_ids ?? record.matchedRuleIds,
    ),
    matchedControlIds: readStringArray(
      record.matched_control_ids ?? record.matchedControlIds,
    ),
    policyReferences: readStringArray(
      record.policy_references ?? record.policyReferences,
    ),
    modelSignals: readStringArray(record.model_signals ?? record.modelSignals),
    receipt:
      record.receipt && typeof record.receipt === "object"
        ? (record.receipt as Record<string, unknown>)
        : undefined,
    modifiedToolArgs:
      record.modified_tool_args && typeof record.modified_tool_args === "object"
        ? (record.modified_tool_args as Record<string, unknown>)
        : record.modifiedToolArgs && typeof record.modifiedToolArgs === "object"
          ? (record.modifiedToolArgs as Record<string, unknown>)
          : undefined,
    modificationReason: readText(
      record.modification_reason ?? record.modificationReason,
    ),
    deferReason: readText(record.defer_reason ?? record.deferReason),
    deferTimeoutSeconds: readNumber(
      record.defer_timeout_seconds ?? record.deferTimeoutSeconds,
    ),
    stepUpTimeoutSeconds: readNumber(
      record.step_up_timeout_seconds ?? record.stepUpTimeoutSeconds,
    ),
    decisionEnvelopeVersion: readText(
      record.decision_envelope_version ?? record.decisionEnvelopeVersion,
    ),
    enforcementTraceId: readText(
      record.enforcement_trace_id ?? record.enforcementTraceId,
    ),
    fastmlFeatures:
      record.fastml_features &&
      typeof record.fastml_features === "object" &&
      !Array.isArray(record.fastml_features)
        ? (record.fastml_features as Record<string, number>)
        : record.fastmlFeatures &&
            typeof record.fastmlFeatures === "object" &&
            !Array.isArray(record.fastmlFeatures)
          ? (record.fastmlFeatures as Record<string, number>)
          : undefined,
    scoreComponents:
      record.score_components && typeof record.score_components === "object"
        ? (record.score_components as Record<string, unknown>)
        : record.scoreComponents && typeof record.scoreComponents === "object"
          ? (record.scoreComponents as Record<string, unknown>)
          : undefined,
    topContributors: Array.isArray(record.top_contributors)
      ? (record.top_contributors as Record<string, unknown>[])
      : Array.isArray(record.topContributors)
        ? (record.topContributors as Record<string, unknown>[])
        : undefined,
    decisionEvidence:
      record.decision_evidence && typeof record.decision_evidence === "object"
        ? (record.decision_evidence as Record<string, unknown>)
        : record.decisionEvidence && typeof record.decisionEvidence === "object"
          ? (record.decisionEvidence as Record<string, unknown>)
          : undefined,
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
    } catch (error) {
      console.error(
        "thoth: step-up poll failure for hold_token=%s:",
        holdToken,
        error,
      );
    }

    await sleep(config.stepUpPollIntervalMs);
  }

  return STEP_UP_TIMEOUT;
}
