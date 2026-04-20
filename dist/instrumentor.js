import { ThothPolicyViolation, EnforcementMode, DecisionType, SourceType, } from "./models";
import { awaitStepUpDecision, checkEnforce } from "./enforcer-client";
import { emitBehavioralEvent } from "./emitter";
const DEFAULTS = {
    enforcement: EnforcementMode.PROGRESSIVE,
    apiKey: (typeof process !== "undefined" && process.env?.THOTH_API_KEY) || undefined,
    userId: "system",
    stepUpTimeoutMinutes: 15,
    stepUpPollIntervalMs: 5000,
    environment: "prod",
};
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
function wrapAsAsyncGenerator(toolName, fn, _config, _sessionId, toolCalls, enforce, emit) {
    return async function* (...args) {
        await emit("TOOL_CALL_PRE", JSON.stringify(args));
        await enforce(args);
        toolCalls.push(toolName);
        const gen = fn(...args);
        const results = [];
        try {
            for await (const chunk of gen) {
                results.push(chunk);
                yield chunk;
            }
        }
        finally {
            await emit("TOOL_CALL_POST", JSON.stringify(results));
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
    for (const tool of tools) {
        const toolName = tool.name ?? String(tool);
        const originalRun = tool.run?.bind(tool);
        if (!originalRun)
            continue;
        const enforce = async (args) => {
            if (cfg.enforcement !== EnforcementMode.OBSERVE) {
                const decision = await checkEnforce(cfg, toolName, sessionId, pendingSessionToolCalls(toolCalls, toolName), toolArgsFromCall(args), enforcementTraceId);
                if (decision.decision === DecisionType.STEP_UP) {
                    const holdToken = decision.holdToken;
                    if (!holdToken) {
                        throw new ThothPolicyViolation(toolName, decision.reason ?? "step-up required but hold token missing", decision.violationId);
                    }
                    const resolved = await awaitStepUpDecision(cfg, holdToken);
                    if (resolved.decision === DecisionType.BLOCK) {
                        throw new ThothPolicyViolation(toolName, resolved.reason ?? "step-up blocked", resolved.violationId);
                    }
                    if (resolved.decision === DecisionType.STEP_UP) {
                        throw new ThothPolicyViolation(toolName, "step-up unresolved", decision.violationId);
                    }
                    return;
                }
                if (decision.decision === DecisionType.BLOCK) {
                    throw new ThothPolicyViolation(toolName, decision.reason ?? "blocked", decision.violationId);
                }
            }
        };
        const emit = async (eventType, content) => {
            const event = {
                eventId: crypto.randomUUID(),
                eventType: eventType,
                agentId: cfg.agentId,
                tenantId: cfg.tenantId,
                sessionId,
                toolName,
                occurredAt: new Date(),
                content,
                sourceType: SourceType.AGENT_TOOL_CALL,
                userId: cfg.userId,
                approvedScope: cfg.approvedScope,
                enforcementMode: cfg.enforcement,
                sessionToolCalls: toolCalls,
            };
            await emitBehavioralEvent(event, cfg.apiUrl, cfg.apiKey ?? "");
        };
        let wrapped;
        if (isAsyncGeneratorFunction(originalRun)) {
            wrapped = wrapAsAsyncGenerator(toolName, originalRun, config, sessionId, toolCalls, enforce, emit);
        }
        else {
            const wrappedAsync = async (...args) => {
                await emit("TOOL_CALL_PRE", JSON.stringify(args));
                await enforce(args);
                const result = await originalRun(...args);
                toolCalls.push(toolName);
                await emit("TOOL_CALL_POST", JSON.stringify(result));
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