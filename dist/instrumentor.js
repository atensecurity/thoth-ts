import { ThothPolicyViolation, EnforcementMode, DecisionType, SourceType, EventType, } from "./models";
import { awaitStepUpDecision, checkEnforce } from "./enforcer-client";
import { emitBehavioralEvent } from "./emitter";
const DEFAULT_ENVIRONMENT = ((typeof process !== "undefined" &&
    (process.env?.THOTH_ENVIRONMENT || process.env?.THOTH_ENV)) ||
    "prod")
    .trim()
    .toLowerCase();
const DEFAULTS = {
    enforcement: EnforcementMode.BLOCK,
    apiKey: (typeof process !== "undefined" && process.env?.THOTH_API_KEY) || undefined,
    userId: "system",
    stepUpTimeoutMinutes: 15,
    stepUpPollIntervalMs: 5000,
    environment: DEFAULT_ENVIRONMENT || "prod",
};
function resolveSdkLogLevel() {
    const raw = ((typeof process !== "undefined" &&
        (process.env?.THOTH_LOG_LEVEL || process.env?.LOG_LEVEL)) ||
        "").trim();
    if (!raw) {
        return null;
    }
    if (/^-?\d+$/.test(raw)) {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) {
            return null;
        }
        if (numeric <= 10)
            return "debug";
        if (numeric <= 20)
            return "info";
        if (numeric <= 30)
            return "warn";
        return "error";
    }
    switch (raw.toUpperCase()) {
        case "TRACE":
        case "DEBUG":
        case "NOTSET":
            return "debug";
        case "INFO":
            return "info";
        case "WARN":
        case "WARNING":
            return "warn";
        case "ERROR":
        case "CRITICAL":
        case "FATAL":
            return "error";
        default:
            return null;
    }
}
function shouldLogDecisionDebug() {
    const level = resolveSdkLogLevel();
    return level === null || level === "debug";
}
function tenantScopedEventId(tenantId) {
    const tenant = tenantId.trim() || "unknown";
    return `${tenant}:${crypto.randomUUID()}`;
}
function resolveApiUrl(config) {
    const fromConfig = config.apiUrl?.trim() ?? "";
    const fromEnv = ((typeof process !== "undefined" && process.env?.THOTH_API_URL) ||
        "").trim();
    const resolved = fromConfig || fromEnv;
    if (!resolved) {
        throw new Error("Thoth API URL is required (set config.apiUrl or THOTH_API_URL)");
    }
    return resolved.replace(/\/$/, "");
}
// Helper to detect async generator functions
function isAsyncGeneratorFunction(fn) {
    return (typeof fn === "function" &&
        fn.constructor?.name === "AsyncGeneratorFunction");
}
function toSerializable(value, seen, depth = 0) {
    if (depth > 5)
        return "[truncated]";
    if (value == null)
        return value;
    if (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return value;
    }
    if (typeof value === "bigint")
        return value.toString();
    if (typeof value === "symbol")
        return value.toString();
    if (typeof value === "function")
        return "[function]";
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value)) {
        return value.map((item) => toSerializable(item, seen, depth + 1));
    }
    if (typeof value === "object") {
        if (seen.has(value))
            return "[circular]";
        seen.add(value);
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = toSerializable(v, seen, depth + 1);
        }
        return out;
    }
    return String(value);
}
function toolArgsFromCall(args) {
    if (args.length === 0)
        return undefined;
    const seen = new WeakSet();
    if (args.length === 1 &&
        args[0] !== null &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0])) {
        return toSerializable(args[0], seen);
    }
    return { args: toSerializable(args, seen) };
}
function pendingSessionToolCalls(toolCalls, toolName) {
    if (toolCalls.length === 0 || toolCalls[toolCalls.length - 1] !== toolName) {
        return [...toolCalls, toolName];
    }
    return [...toolCalls];
}
function buildDeferredReason(decision) {
    const base = decision.deferReason ??
        decision.reason ??
        "deferred pending additional context";
    if (typeof decision.deferTimeoutSeconds === "number" &&
        Number.isFinite(decision.deferTimeoutSeconds) &&
        decision.deferTimeoutSeconds > 0) {
        return `${base} (retry in ${decision.deferTimeoutSeconds}s)`;
    }
    return base;
}
function logDecision(toolName, decision, phase, sessionId, traceId) {
    if (typeof console?.debug !== "function" || !shouldLogDecisionDebug()) {
        return;
    }
    console.debug("thoth %s decision tool=%s decision=%s reason_code=%s reason=%s hold_token=%s trace_id=%s session_id=%s", phase, toolName, decision.decision, decision.decisionReasonCode ?? "", decision.reason ?? "", decision.holdToken ?? "", traceId, sessionId);
}
function applyModifiedArgs(args, modifiedToolArgs) {
    if (!modifiedToolArgs)
        return args;
    const argsValue = modifiedToolArgs.args;
    if (Array.isArray(argsValue)) {
        return argsValue;
    }
    if (args.length === 1 &&
        args[0] !== null &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0])) {
        return [modifiedToolArgs];
    }
    if ("arg0" in modifiedToolArgs) {
        return [modifiedToolArgs["arg0"]];
    }
    if ("input" in modifiedToolArgs) {
        return [modifiedToolArgs["input"]];
    }
    const indexed = Object.entries(modifiedToolArgs)
        .map(([key, value]) => {
        const match = /^arg(\d+)$/.exec(key);
        return match ? { index: Number(match[1]), value } : null;
    })
        .filter((entry) => entry !== null)
        .sort((a, b) => a.index - b.index);
    if (indexed.length > 0 &&
        indexed[0].index === 0 &&
        indexed[indexed.length - 1].index === indexed.length - 1) {
        return indexed.map((entry) => entry.value);
    }
    return args;
}
function payloadSizeBytes(value) {
    try {
        return JSON.stringify(value).length;
    }
    catch {
        return undefined;
    }
}
function decisionToMetadata(decision) {
    if (!decision) {
        return {};
    }
    const metadata = {
        authorization_decision: decision.authorizationDecision ?? decision.decision,
    };
    if (decision.decisionReasonCode) {
        metadata.decision_reason_code = decision.decisionReasonCode;
    }
    if (decision.actionClassification) {
        metadata.action_classification = decision.actionClassification;
    }
    if (decision.deferTimeoutSeconds) {
        metadata.defer_timeout_seconds = decision.deferTimeoutSeconds;
    }
    if (decision.stepUpTimeoutSeconds) {
        metadata.step_up_timeout_seconds = decision.stepUpTimeoutSeconds;
    }
    if (typeof decision.riskScore === "number") {
        metadata.risk_score = decision.riskScore;
    }
    if (typeof decision.latencyMs === "number") {
        metadata.latency_ms = decision.latencyMs;
    }
    if (decision.packId) {
        metadata.pack_id = decision.packId;
    }
    if (decision.packVersion) {
        metadata.pack_version = decision.packVersion;
    }
    if (typeof decision.ruleVersion === "number") {
        metadata.rule_version = decision.ruleVersion;
    }
    if (decision.regulatoryRegimes) {
        metadata.regulatory_regimes = decision.regulatoryRegimes;
    }
    if (decision.matchedRuleIds) {
        metadata.matched_rule_ids = decision.matchedRuleIds;
    }
    if (decision.matchedControlIds) {
        metadata.matched_control_ids = decision.matchedControlIds;
    }
    if (decision.policyReferences) {
        metadata.policy_references = decision.policyReferences;
    }
    if (decision.modelSignals) {
        metadata.model_signals = decision.modelSignals;
    }
    if (decision.receipt) {
        metadata.receipt = decision.receipt;
    }
    return metadata;
}
function createPolicyViolation(toolName, decision, fallbackReason) {
    return new ThothPolicyViolation(toolName, decision.reason ?? fallbackReason, decision.violationId, {
        decisionReasonCode: decision.decisionReasonCode,
        actionClassification: decision.actionClassification,
        authorizationDecision: decision.authorizationDecision ?? decision.decision,
        deferTimeoutSeconds: decision.deferTimeoutSeconds,
        stepUpTimeoutSeconds: decision.stepUpTimeoutSeconds,
        riskScore: decision.riskScore,
        latencyMs: decision.latencyMs,
        packId: decision.packId,
        packVersion: decision.packVersion,
        ruleVersion: decision.ruleVersion,
        regulatoryRegimes: decision.regulatoryRegimes,
        matchedRuleIds: decision.matchedRuleIds,
        matchedControlIds: decision.matchedControlIds,
        policyReferences: decision.policyReferences,
        modelSignals: decision.modelSignals,
        receipt: decision.receipt,
    });
}
function baseToolEventMetadata(toolName, args, cfg, enforcementTraceId) {
    const toolArgs = toolArgsFromCall(args);
    return {
        sdk_language: "typescript",
        environment: cfg.environment,
        enforcement_trace_id: enforcementTraceId,
        ...(cfg.purpose !== undefined ? { purpose: cfg.purpose } : {}),
        ...(cfg.purpose !== undefined ? { purpose_context: cfg.purpose } : {}),
        ...(cfg.dataClassification !== undefined
            ? { data_classification: cfg.dataClassification }
            : {}),
        ...(cfg.taskContext !== undefined
            ? {
                task_context: cfg.taskContext,
                delegation_context: cfg.taskContext,
            }
            : {}),
        tool_call: {
            name: toolName,
            arguments: toolArgs,
        },
        tool_args: toolArgs,
    };
}
function policyViolationMetadata(violation) {
    const metadata = {
        authorization_decision: violation.authorizationDecision ?? DecisionType.BLOCK,
    };
    if (violation.decisionReasonCode) {
        metadata.decision_reason_code = violation.decisionReasonCode;
    }
    if (violation.actionClassification) {
        metadata.action_classification = violation.actionClassification;
    }
    if (violation.deferTimeoutSeconds) {
        metadata.defer_timeout_seconds = violation.deferTimeoutSeconds;
    }
    if (violation.stepUpTimeoutSeconds) {
        metadata.step_up_timeout_seconds = violation.stepUpTimeoutSeconds;
    }
    if (typeof violation.riskScore === "number") {
        metadata.risk_score = violation.riskScore;
    }
    if (typeof violation.latencyMs === "number") {
        metadata.latency_ms = violation.latencyMs;
    }
    if (violation.packId) {
        metadata.pack_id = violation.packId;
    }
    if (violation.packVersion) {
        metadata.pack_version = violation.packVersion;
    }
    if (typeof violation.ruleVersion === "number") {
        metadata.rule_version = violation.ruleVersion;
    }
    if (violation.regulatoryRegimes) {
        metadata.regulatory_regimes = violation.regulatoryRegimes;
    }
    if (violation.matchedRuleIds) {
        metadata.matched_rule_ids = violation.matchedRuleIds;
    }
    if (violation.matchedControlIds) {
        metadata.matched_control_ids = violation.matchedControlIds;
    }
    if (violation.policyReferences) {
        metadata.policy_references = violation.policyReferences;
    }
    if (violation.modelSignals) {
        metadata.model_signals = violation.modelSignals;
    }
    if (violation.receipt) {
        metadata.receipt = violation.receipt;
    }
    return metadata;
}
function wrapAsAsyncGenerator(toolName, fn, toolCalls, enforce, emit, baseMetadataForArgs) {
    return async function* (...args) {
        const baseMetadata = baseMetadataForArgs(args);
        const start = Date.now();
        const sessionToolCalls = pendingSessionToolCalls(toolCalls, toolName);
        await emit({
            eventType: EventType.TOOL_CALL_PRE,
            content: "tool invocation requested",
            sessionToolCalls,
            metadata: {
                ...baseMetadata,
                event_phase: "pre",
            },
        });
        let effectiveArgs;
        let decision;
        try {
            const outcome = await enforce(args);
            effectiveArgs = outcome.effectiveArgs;
            decision = outcome.decision;
        }
        catch (error) {
            if (error instanceof ThothPolicyViolation) {
                await emit({
                    eventType: EventType.TOOL_CALL_BLOCK,
                    content: error.reason,
                    sessionToolCalls,
                    violationId: error.violationId,
                    metadata: {
                        ...baseMetadata,
                        ...policyViolationMetadata(error),
                        event_phase: "block",
                        duration_ms: Date.now() - start,
                    },
                });
            }
            throw error;
        }
        toolCalls.push(toolName);
        const gen = fn(...effectiveArgs);
        const results = [];
        try {
            for await (const chunk of gen) {
                results.push(chunk);
                yield chunk;
            }
            await emit({
                eventType: EventType.TOOL_CALL_POST,
                content: "tool invocation completed",
                sessionToolCalls: toolCalls,
                metadata: {
                    ...baseMetadata,
                    ...decisionToMetadata(decision),
                    event_phase: "post",
                    duration_ms: Date.now() - start,
                    result_type: "array",
                    result_size_bytes: payloadSizeBytes(results),
                },
            });
        }
        finally {
            // no-op: handled above so we can emit richer metadata and duration
        }
    };
}
export function instrument(agent, config) {
    const apiUrl = resolveApiUrl(config);
    const cfg = { ...DEFAULTS, ...config };
    cfg.apiUrl = apiUrl;
    const sessionId = crypto.randomUUID();
    const enforcementTraceId = cfg.enforcementTraceId ?? sessionId;
    const toolCalls = [];
    const tools = agent.tools;
    if (!Array.isArray(tools))
        return agent;
    const llmInvocationEvent = {
        eventId: tenantScopedEventId(cfg.tenantId),
        eventType: EventType.LLM_INVOCATION,
        agentId: cfg.agentId,
        tenantId: cfg.tenantId,
        sessionId,
        purpose: cfg.purpose,
        dataClassification: cfg.dataClassification,
        taskContext: cfg.taskContext,
        initiatedBy: typeof cfg.taskContext?.["initiated_by"] === "string"
            ? cfg.taskContext["initiated_by"]
            : typeof cfg.taskContext?.["initiatedBy"] === "string"
                ? cfg.taskContext["initiatedBy"]
                : undefined,
        taskId: typeof cfg.taskContext?.["task_id"] === "string"
            ? cfg.taskContext["task_id"]
            : typeof cfg.taskContext?.["taskId"] === "string"
                ? cfg.taskContext["taskId"]
                : undefined,
        delegationChain: Array.isArray(cfg.taskContext?.["chain"])
            ? (cfg.taskContext?.["chain"])
                .map((item) => String(item).trim())
                .filter((item) => item.length > 0)
            : undefined,
        toolName: "thoth_sdk",
        occurredAt: new Date(),
        content: "thoth_sdk_session_start",
        sourceType: SourceType.AGENT_LLM_INVOCATION,
        userId: cfg.userId,
        approvedScope: cfg.approvedScope,
        enforcementMode: cfg.enforcement,
        sessionToolCalls: [],
        metadata: {
            enforcement_trace_id: enforcementTraceId,
            environment: cfg.environment,
            ...(cfg.purpose !== undefined ? { purpose: cfg.purpose } : {}),
            ...(cfg.purpose !== undefined ? { purpose_context: cfg.purpose } : {}),
            ...(cfg.dataClassification !== undefined
                ? { data_classification: cfg.dataClassification }
                : {}),
            ...(cfg.taskContext !== undefined
                ? {
                    task_context: cfg.taskContext,
                    delegation_context: cfg.taskContext,
                }
                : {}),
        },
    };
    void emitBehavioralEvent(llmInvocationEvent, cfg.apiUrl, cfg.apiKey ?? "").catch(() => undefined);
    for (const tool of tools) {
        const toolName = tool.name ?? String(tool);
        const originalRun = tool.run?.bind(tool);
        if (!originalRun)
            continue;
        const enforce = async (args) => {
            if (cfg.enforcement === EnforcementMode.OBSERVE) {
                return { effectiveArgs: args };
            }
            const decision = await checkEnforce(cfg, toolName, sessionId, pendingSessionToolCalls(toolCalls, toolName), toolArgsFromCall(args), enforcementTraceId);
            logDecision(toolName, decision, "enforce", sessionId, enforcementTraceId);
            if (decision.decision === DecisionType.STEP_UP) {
                const holdToken = decision.holdToken;
                if (!holdToken) {
                    throw createPolicyViolation(toolName, decision, "step-up required but hold token missing");
                }
                const resolved = await awaitStepUpDecision(cfg, holdToken);
                logDecision(toolName, resolved, "step_up_resolved", sessionId, enforcementTraceId);
                if (resolved.decision === DecisionType.BLOCK) {
                    throw createPolicyViolation(toolName, resolved, "step-up blocked");
                }
                if (resolved.decision === DecisionType.STEP_UP) {
                    throw new ThothPolicyViolation(toolName, "step-up unresolved", decision.violationId ?? resolved.violationId, {
                        decisionReasonCode: resolved.decisionReasonCode ?? decision.decisionReasonCode,
                        actionClassification: resolved.actionClassification ?? decision.actionClassification,
                        authorizationDecision: DecisionType.STEP_UP,
                        stepUpTimeoutSeconds: resolved.stepUpTimeoutSeconds ?? decision.stepUpTimeoutSeconds,
                        riskScore: resolved.riskScore ?? decision.riskScore,
                        latencyMs: resolved.latencyMs ?? decision.latencyMs,
                        packId: resolved.packId ?? decision.packId,
                        packVersion: resolved.packVersion ?? decision.packVersion,
                        ruleVersion: resolved.ruleVersion ?? decision.ruleVersion,
                        regulatoryRegimes: resolved.regulatoryRegimes ?? decision.regulatoryRegimes,
                        matchedRuleIds: resolved.matchedRuleIds ?? decision.matchedRuleIds,
                        matchedControlIds: resolved.matchedControlIds ?? decision.matchedControlIds,
                        policyReferences: resolved.policyReferences ?? decision.policyReferences,
                        modelSignals: resolved.modelSignals ?? decision.modelSignals,
                        receipt: resolved.receipt ?? decision.receipt,
                    });
                }
                if (resolved.decision === DecisionType.DEFER) {
                    throw new ThothPolicyViolation(toolName, buildDeferredReason(resolved), resolved.violationId, {
                        decisionReasonCode: resolved.decisionReasonCode,
                        actionClassification: resolved.actionClassification,
                        authorizationDecision: DecisionType.DEFER,
                        deferTimeoutSeconds: resolved.deferTimeoutSeconds,
                        riskScore: resolved.riskScore,
                        latencyMs: resolved.latencyMs,
                        packId: resolved.packId,
                        packVersion: resolved.packVersion,
                        ruleVersion: resolved.ruleVersion,
                        regulatoryRegimes: resolved.regulatoryRegimes,
                        matchedRuleIds: resolved.matchedRuleIds,
                        matchedControlIds: resolved.matchedControlIds,
                        policyReferences: resolved.policyReferences,
                        modelSignals: resolved.modelSignals,
                        receipt: resolved.receipt,
                    });
                }
                if (resolved.decision === DecisionType.MODIFY) {
                    return {
                        effectiveArgs: applyModifiedArgs(args, resolved.modifiedToolArgs),
                        decision: resolved,
                    };
                }
                return { effectiveArgs: args, decision: resolved };
            }
            if (decision.decision === DecisionType.BLOCK) {
                throw createPolicyViolation(toolName, decision, "blocked");
            }
            if (decision.decision === DecisionType.DEFER) {
                throw new ThothPolicyViolation(toolName, buildDeferredReason(decision), decision.violationId, {
                    decisionReasonCode: decision.decisionReasonCode,
                    actionClassification: decision.actionClassification,
                    authorizationDecision: DecisionType.DEFER,
                    deferTimeoutSeconds: decision.deferTimeoutSeconds,
                    riskScore: decision.riskScore,
                    latencyMs: decision.latencyMs,
                    packId: decision.packId,
                    packVersion: decision.packVersion,
                    ruleVersion: decision.ruleVersion,
                    regulatoryRegimes: decision.regulatoryRegimes,
                    matchedRuleIds: decision.matchedRuleIds,
                    matchedControlIds: decision.matchedControlIds,
                    policyReferences: decision.policyReferences,
                    modelSignals: decision.modelSignals,
                    receipt: decision.receipt,
                });
            }
            if (decision.decision === DecisionType.MODIFY) {
                return {
                    effectiveArgs: applyModifiedArgs(args, decision.modifiedToolArgs),
                    decision,
                };
            }
            return { effectiveArgs: args, decision };
        };
        const emit = async ({ eventType, content, sessionToolCalls, metadata, violationId, }) => {
            const event = {
                eventId: tenantScopedEventId(cfg.tenantId),
                eventType,
                agentId: cfg.agentId,
                tenantId: cfg.tenantId,
                sessionId,
                purpose: cfg.purpose,
                dataClassification: cfg.dataClassification,
                taskContext: cfg.taskContext,
                initiatedBy: typeof cfg.taskContext?.["initiated_by"] === "string"
                    ? cfg.taskContext["initiated_by"]
                    : typeof cfg.taskContext?.["initiatedBy"] === "string"
                        ? cfg.taskContext["initiatedBy"]
                        : undefined,
                taskId: typeof cfg.taskContext?.["task_id"] === "string"
                    ? cfg.taskContext["task_id"]
                    : typeof cfg.taskContext?.["taskId"] === "string"
                        ? cfg.taskContext["taskId"]
                        : undefined,
                delegationChain: Array.isArray(cfg.taskContext?.["chain"])
                    ? (cfg.taskContext?.["chain"])
                        .map((item) => String(item).trim())
                        .filter((item) => item.length > 0)
                    : undefined,
                toolName,
                occurredAt: new Date(),
                content,
                sourceType: SourceType.AGENT_TOOL_CALL,
                userId: cfg.userId,
                approvedScope: cfg.approvedScope,
                enforcementMode: cfg.enforcement,
                sessionToolCalls,
                metadata,
                violationId,
            };
            await emitBehavioralEvent(event, cfg.apiUrl, cfg.apiKey ?? "");
        };
        let wrapped;
        if (isAsyncGeneratorFunction(originalRun)) {
            wrapped = wrapAsAsyncGenerator(toolName, originalRun, toolCalls, enforce, emit, (args) => baseToolEventMetadata(toolName, args, cfg, enforcementTraceId));
        }
        else {
            const wrappedAsync = async (...args) => {
                const start = Date.now();
                const baseMetadata = baseToolEventMetadata(toolName, args, cfg, enforcementTraceId);
                const sessionToolCalls = pendingSessionToolCalls(toolCalls, toolName);
                await emit({
                    eventType: EventType.TOOL_CALL_PRE,
                    content: "tool invocation requested",
                    sessionToolCalls,
                    metadata: {
                        ...baseMetadata,
                        event_phase: "pre",
                    },
                });
                let outcome;
                try {
                    outcome = await enforce(args);
                }
                catch (error) {
                    if (error instanceof ThothPolicyViolation) {
                        await emit({
                            eventType: EventType.TOOL_CALL_BLOCK,
                            content: error.reason,
                            sessionToolCalls,
                            violationId: error.violationId,
                            metadata: {
                                ...baseMetadata,
                                ...policyViolationMetadata(error),
                                event_phase: "block",
                                duration_ms: Date.now() - start,
                            },
                        });
                    }
                    throw error;
                }
                const result = await originalRun(...outcome.effectiveArgs);
                toolCalls.push(toolName);
                await emit({
                    eventType: EventType.TOOL_CALL_POST,
                    content: "tool invocation completed",
                    sessionToolCalls: toolCalls,
                    metadata: {
                        ...baseMetadata,
                        ...decisionToMetadata(outcome.decision),
                        event_phase: "post",
                        duration_ms: Date.now() - start,
                        result_type: result === null ? "null" : typeof result,
                        result_size_bytes: payloadSizeBytes(result),
                    },
                });
                return result;
            };
            wrapped = wrappedAsync;
        }
        // Preserve the original function name (equivalent of functools.wraps)
        Object.defineProperty(wrapped, "name", {
            value: originalRun.name,
            configurable: true,
        });
        tool.run = wrapped;
    }
    return agent;
}
//# sourceMappingURL=instrumentor.js.map