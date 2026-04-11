import { ThothPolicyViolation, EnforcementMode, DecisionType, SourceType, } from "./models";
import { checkEnforce } from "./enforcer-client";
import { emitBehavioralEvent } from "./emitter";
const DEFAULTS = {
    enforcement: EnforcementMode.PROGRESSIVE,
    apiKey: (typeof process !== "undefined" && process.env?.THOTH_API_KEY) || undefined,
    userId: "system",
    stepUpTimeoutMinutes: 15,
    stepUpPollIntervalMs: 5000,
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
function wrapAsAsyncGenerator(toolName, fn, _config, _sessionId, _toolCalls, enforce, emit) {
    return async function* (...args) {
        await emit("TOOL_CALL_PRE", JSON.stringify(args));
        await enforce();
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
    const toolCalls = [];
    const tools = agent.tools;
    if (!Array.isArray(tools))
        return agent;
    for (const tool of tools) {
        const toolName = tool.name ?? String(tool);
        const originalRun = tool.run?.bind(tool);
        if (!originalRun)
            continue;
        const enforce = async () => {
            if (cfg.enforcement !== EnforcementMode.OBSERVE) {
                const decision = await checkEnforce(cfg, toolName, sessionId, toolCalls);
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
                await enforce();
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