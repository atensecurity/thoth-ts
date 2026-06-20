import { describe, expect, it, vi } from "vitest";
import { instrument } from "../instrumentor";
import { ThothPolicyViolation } from "../models";
class CompatTool {
    constructor(run) {
        this.run = run;
        this.name = "search:docs";
    }
}
class CompatAgent {
    constructor(run) {
        this.tools = [new CompatTool(run)];
    }
}
let ddTraceInitialized = false;
async function maybeImport(specifier) {
    try {
        return (await import(specifier));
    }
    catch {
        return null;
    }
}
async function runtimeHarness(stack, events, next) {
    if (stack === "datadog") {
        const ddtraceModule = await maybeImport("dd-trace");
        if (!ddtraceModule) {
            return null;
        }
        const ddtrace = ddtraceModule.default ?? ddtraceModule;
        if (!ddTraceInitialized) {
            ddtrace.init({
                hostname: "127.0.0.1",
                port: 9,
                startupLogs: false,
                runtimeMetrics: false,
                service: "thoth-compat",
            });
            ddTraceInitialized = true;
        }
        return {
            run: async (input) => ddtrace.trace("search_tool", async () => {
                events.push("datadog:run");
                return next(input);
            }),
        };
    }
    if (stack === "langsmith") {
        process.env.LANGSMITH_TRACING = "true";
        process.env.LANGSMITH_TRACING_V2 = "true";
        process.env.LANGSMITH_API_KEY = "test-key";
        process.env.LANGSMITH_ENDPOINT = "http://127.0.0.1:9";
        const langsmithRoot = await maybeImport("langsmith");
        const langsmithTraceable = await maybeImport("langsmith/traceable");
        const traceable = langsmithRoot?.traceable ??
            langsmithTraceable?.traceable ??
            langsmithTraceable?.default;
        if (typeof traceable !== "function") {
            return null;
        }
        const traced = traceable(async (input) => {
            events.push("langsmith:run");
            return next(input);
        }, {
            name: "search_tool",
        });
        return {
            run: async (input) => traced(input),
        };
    }
    if (stack === "opentelemetry") {
        const otelApi = await maybeImport("@opentelemetry/api");
        const otelSdk = await maybeImport("@opentelemetry/sdk-trace-base");
        if (!otelApi || !otelSdk) {
            return null;
        }
        const provider = new otelSdk.BasicTracerProvider();
        otelApi.trace.setGlobalTracerProvider(provider);
        const tracer = otelApi.trace.getTracer("thoth-compat");
        return {
            run: async (input) => {
                const span = tracer.startSpan("search_tool");
                try {
                    events.push("opentelemetry:run");
                    return await next(input);
                }
                finally {
                    span.end();
                }
            },
            cleanup: async () => {
                await provider.shutdown();
            },
        };
    }
    if (stack === "sentry") {
        const sentryModule = await maybeImport("@sentry/node");
        if (!sentryModule) {
            return null;
        }
        const sentry = sentryModule.default ?? sentryModule;
        sentry.init({
            dsn: "https://public@example.com/1",
            tracesSampleRate: 1.0,
            transport: () => ({
                send: async () => ({ status: "success" }),
                flush: async () => true,
            }),
        });
        return {
            run: async (input) => sentry.startSpan({ op: "tool", name: "search_tool" }, async () => {
                events.push("sentry:run");
                return next(input);
            }),
            cleanup: async () => {
                await sentry.close(200);
            },
        };
    }
    return null;
}
const allStacks = ["datadog", "langsmith", "opentelemetry", "sentry"];
const stackFilter = process.env.THOTH_COMPAT_STACK;
const testStacks = stackFilter ? [stackFilter] : allStacks;
function ensureHarness(stack, harness) {
    if (harness) {
        return harness;
    }
    if (stackFilter === stack) {
        throw new Error(`runtime harness for ${stack} is unavailable`);
    }
    return null;
}
describe("instrument() vendor runtime compatibility", () => {
    const apiUrl = "https://enforce.trantor.atensecurity.com";
    it.each(testStacks)("coexists with %s runtime stack on ALLOW for both wrapper orders", async (stack) => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const eventsOuter = [];
        const calledOuter = { value: false };
        const baseOuter = async (input) => {
            calledOuter.value = true;
            eventsOuter.push("tool:run");
            return `ok:${input}`;
        };
        const outerHarness = ensureHarness(stack, await runtimeHarness(stack, eventsOuter, baseOuter));
        if (!outerHarness) {
            return;
        }
        const agentOuter = new CompatAgent(outerHarness.run);
        instrument(agentOuter, {
            agentId: `${stack}-thoth-outer`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        try {
            const outOuter = await agentOuter.tools[0].run("incident-42");
            expect(outOuter).toBe("ok:incident-42");
            expect(calledOuter.value).toBe(true);
        }
        finally {
            await outerHarness.cleanup?.();
        }
        const eventsInner = [];
        const calledInner = { value: false };
        const baseInner = async (input) => {
            calledInner.value = true;
            eventsInner.push("tool:run");
            return `ok:${input}`;
        };
        const agentInner = new CompatAgent(baseInner);
        instrument(agentInner, {
            agentId: `${stack}-thoth-inner`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        const innerHarness = ensureHarness(stack, await runtimeHarness(stack, eventsInner, agentInner.tools[0].run.bind(agentInner.tools[0])));
        if (!innerHarness) {
            return;
        }
        try {
            const outInner = await innerHarness.run("incident-42");
            expect(outInner).toBe("ok:incident-42");
            expect(calledInner.value).toBe(true);
        }
        finally {
            await innerHarness.cleanup?.();
        }
    });
    it.each(testStacks)("preserves BLOCK behavior with %s runtime stack on both wrapper orders", async (stack) => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                decision: "BLOCK",
                reason: "blocked by policy",
                violation_id: "vio-runtime-compat-ts-001",
            }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const eventsOuter = [];
        const calledOuter = { value: false };
        const baseOuter = async (input) => {
            calledOuter.value = true;
            eventsOuter.push("tool:run");
            return `ok:${input}`;
        };
        const outerHarness = ensureHarness(stack, await runtimeHarness(stack, eventsOuter, baseOuter));
        if (!outerHarness) {
            return;
        }
        const agentOuter = new CompatAgent(outerHarness.run);
        instrument(agentOuter, {
            agentId: `${stack}-thoth-outer`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        try {
            await expect(agentOuter.tools[0].run("incident-42")).rejects.toThrow(ThothPolicyViolation);
            expect(calledOuter.value).toBe(false);
        }
        finally {
            await outerHarness.cleanup?.();
        }
        const eventsInner = [];
        const calledInner = { value: false };
        const baseInner = async (input) => {
            calledInner.value = true;
            eventsInner.push("tool:run");
            return `ok:${input}`;
        };
        const agentInner = new CompatAgent(baseInner);
        instrument(agentInner, {
            agentId: `${stack}-thoth-inner`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        const innerHarness = ensureHarness(stack, await runtimeHarness(stack, eventsInner, agentInner.tools[0].run.bind(agentInner.tools[0])));
        if (!innerHarness) {
            return;
        }
        try {
            await expect(innerHarness.run("incident-42")).rejects.toThrow(ThothPolicyViolation);
            expect(calledInner.value).toBe(false);
        }
        finally {
            await innerHarness.cleanup?.();
        }
    });
});
//# sourceMappingURL=compatibility.runtime.test.js.map