import {
  ThothConfig,
  ThothPolicyViolation,
  EnforcementMode,
  DecisionType,
  BehavioralEvent,
  SourceType,
  EventType,
} from "./models";
import { awaitStepUpDecision, checkEnforce } from "./enforcer-client";
import { emitBehavioralEvent } from "./emitter";

const DEFAULTS = {
  enforcement: EnforcementMode.PROGRESSIVE,
  apiKey:
    (typeof process !== "undefined" && process.env?.THOTH_API_KEY) || undefined,
  userId: "system",
  stepUpTimeoutMinutes: 15,
  stepUpPollIntervalMs: 5000,
  environment: "prod",
};

function resolveApiUrl(config: ThothConfig): string {
  const fromConfig = config.apiUrl?.trim() ?? "";
  const fromEnv = (
    (typeof process !== "undefined" && process.env?.THOTH_API_URL) ||
    ""
  ).trim();
  const resolved = fromConfig || fromEnv;
  if (!resolved) {
    throw new Error(
      "Thoth API URL is required (set config.apiUrl or THOTH_API_URL)",
    );
  }
  return resolved.replace(/\/$/, "");
}

// Helper to detect async generator functions
function isAsyncGeneratorFunction(
  fn: unknown,
): fn is (...args: unknown[]) => AsyncGenerator {
  return (
    typeof fn === "function" &&
    fn.constructor?.name === "AsyncGeneratorFunction"
  );
}

function toSerializable(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (depth > 5) return "[truncated]";
  if (value == null) return value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toSerializable(v, seen, depth + 1);
    }
    return out;
  }
  return String(value);
}

function toolArgsFromCall(
  args: unknown[],
): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const seen = new WeakSet<object>();
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0])
  ) {
    return toSerializable(args[0], seen) as Record<string, unknown>;
  }
  return { args: toSerializable(args, seen) };
}

function pendingSessionToolCalls(
  toolCalls: string[],
  toolName: string,
): string[] {
  if (toolCalls.length === 0 || toolCalls[toolCalls.length - 1] !== toolName) {
    return [...toolCalls, toolName];
  }
  return [...toolCalls];
}

function buildDeferredReason(
  decision: {
    reason?: string;
    deferReason?: string;
    deferTimeoutSeconds?: number;
  },
): string {
  const base =
    decision.deferReason ??
    decision.reason ??
    "deferred pending additional context";
  if (
    typeof decision.deferTimeoutSeconds === "number" &&
    Number.isFinite(decision.deferTimeoutSeconds) &&
    decision.deferTimeoutSeconds > 0
  ) {
    return `${base} (retry in ${decision.deferTimeoutSeconds}s)`;
  }
  return base;
}

function applyModifiedArgs(
  args: unknown[],
  modifiedToolArgs?: Record<string, unknown>,
): unknown[] {
  if (!modifiedToolArgs) return args;

  const argsValue = modifiedToolArgs.args;
  if (Array.isArray(argsValue)) {
    return argsValue;
  }

  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0])
  ) {
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
    .filter((entry): entry is { index: number; value: unknown } => entry !== null)
    .sort((a, b) => a.index - b.index);
  if (
    indexed.length > 0 &&
    indexed[0].index === 0 &&
    indexed[indexed.length - 1].index === indexed.length - 1
  ) {
    return indexed.map((entry) => entry.value);
  }

  return args;
}

function wrapAsAsyncGenerator(
  toolName: string,
  fn: (...args: unknown[]) => AsyncGenerator,
  _config: ThothConfig,
  _sessionId: string,
  toolCalls: string[],
  enforce: (args: unknown[]) => Promise<unknown[]>,
  emit: (eventType: string, content: string) => Promise<void>,
): (...args: unknown[]) => AsyncGenerator {
  return async function* (...args: unknown[]) {
    await emit("TOOL_CALL_PRE", JSON.stringify(args));
    const effectiveArgs = await enforce(args);
    toolCalls.push(toolName);
    const gen = fn(...effectiveArgs);
    const results: unknown[] = [];
    try {
      for await (const chunk of gen) {
        results.push(chunk);
        yield chunk;
      }
    } finally {
      await emit("TOOL_CALL_POST", JSON.stringify(results));
    }
  };
}

export function instrument<T extends object>(agent: T, config: ThothConfig): T {
  const apiUrl = resolveApiUrl(config);
  const cfg = { ...DEFAULTS, ...config } as Required<ThothConfig> & {
    apiUrl: string;
  };
  cfg.apiUrl = apiUrl;
  const sessionId = crypto.randomUUID();
  const enforcementTraceId = cfg.enforcementTraceId ?? sessionId;
  const toolCalls: string[] = [];

  const tools = (agent as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return agent;

  for (const tool of tools) {
    const toolName: string = tool.name ?? String(tool);
    const originalRun = tool.run?.bind(tool);
    if (!originalRun) continue;

    const enforce = async (args: unknown[]): Promise<unknown[]> => {
      if (cfg.enforcement !== EnforcementMode.OBSERVE) {
        const decision = await checkEnforce(
          cfg,
          toolName,
          sessionId,
          pendingSessionToolCalls(toolCalls, toolName),
          toolArgsFromCall(args),
          enforcementTraceId,
        );
        if (decision.decision === DecisionType.STEP_UP) {
          const holdToken = decision.holdToken;
          if (!holdToken) {
            throw new ThothPolicyViolation(
              toolName,
              decision.reason ?? "step-up required but hold token missing",
              decision.violationId,
            );
          }
          const resolved = await awaitStepUpDecision(cfg, holdToken);
          if (resolved.decision === DecisionType.BLOCK) {
            throw new ThothPolicyViolation(
              toolName,
              resolved.reason ?? "step-up blocked",
              resolved.violationId,
            );
          }
          if (resolved.decision === DecisionType.STEP_UP) {
            throw new ThothPolicyViolation(
              toolName,
              "step-up unresolved",
              decision.violationId,
            );
          }
          if (resolved.decision === DecisionType.DEFER) {
            throw new ThothPolicyViolation(
              toolName,
              buildDeferredReason(resolved),
              resolved.violationId,
            );
          }
          if (resolved.decision === DecisionType.MODIFY) {
            return applyModifiedArgs(args, resolved.modifiedToolArgs);
          }
          return args;
        }
        if (decision.decision === DecisionType.BLOCK) {
          throw new ThothPolicyViolation(
            toolName,
            decision.reason ?? "blocked",
            decision.violationId,
          );
        }
        if (decision.decision === DecisionType.DEFER) {
          throw new ThothPolicyViolation(
            toolName,
            buildDeferredReason(decision),
            decision.violationId,
          );
        }
        if (decision.decision === DecisionType.MODIFY) {
          return applyModifiedArgs(args, decision.modifiedToolArgs);
        }
      }
      return args;
    };

    const emit = async (eventType: string, content: string): Promise<void> => {
      const event: BehavioralEvent = {
        eventId: crypto.randomUUID(),
        eventType: eventType as EventType,
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

    let wrapped: (...args: unknown[]) => unknown;

    if (isAsyncGeneratorFunction(originalRun)) {
      wrapped = wrapAsAsyncGenerator(
        toolName,
        originalRun as (...args: unknown[]) => AsyncGenerator,
        config,
        sessionId,
        toolCalls,
        enforce,
        emit,
      );
    } else {
      const wrappedAsync = async (...args: unknown[]) => {
        await emit("TOOL_CALL_PRE", JSON.stringify(args));
        const effectiveArgs = await enforce(args);
        const result = await originalRun(...effectiveArgs);
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
