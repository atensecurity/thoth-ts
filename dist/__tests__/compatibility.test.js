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
function wrapObservabilityLike(stack, events, next) {
    return async (input) => {
        events.push(`${stack}:start`);
        try {
            const result = await next(input);
            events.push(`${stack}:end`);
            return result;
        }
        catch (error) {
            events.push(`${stack}:error`);
            throw error;
        }
    };
}
function makeBaseTool(events, called) {
    return async (input) => {
        called.value = true;
        events.push("tool:run");
        return `ok:${input}`;
    };
}
describe("instrument() compatibility wrappers", () => {
    const apiUrl = "https://enforce.trantor.atensecurity.com";
    const stacks = ["datadog", "langsmith", "opentelemetry", "sentry"];
    it.each(stacks)("coexists with %s-style wrapper on ALLOW for both wrapper orders", async (stack) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        }));
        const calledOuter = { value: false };
        const eventsOuter = [];
        const baseOuter = makeBaseTool(eventsOuter, calledOuter);
        const wrappedBeforeInstrument = wrapObservabilityLike(stack, eventsOuter, baseOuter);
        const thothOuter = new CompatAgent(wrappedBeforeInstrument);
        instrument(thothOuter, {
            agentId: `${stack}-thoth-outer`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        const resultOuter = await thothOuter.tools[0].run("incident-42");
        expect(resultOuter).toBe("ok:incident-42");
        expect(calledOuter.value).toBe(true);
        expect(eventsOuter).toEqual([`${stack}:start`, "tool:run", `${stack}:end`]);
        const calledInner = { value: false };
        const eventsInner = [];
        const baseInner = makeBaseTool(eventsInner, calledInner);
        const thothInner = new CompatAgent(baseInner);
        instrument(thothInner, {
            agentId: `${stack}-thoth-inner`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        thothInner.tools[0].run = wrapObservabilityLike(stack, eventsInner, thothInner.tools[0].run.bind(thothInner.tools[0]));
        const resultInner = await thothInner.tools[0].run("incident-42");
        expect(resultInner).toBe("ok:incident-42");
        expect(calledInner.value).toBe(true);
        expect(eventsInner).toEqual([`${stack}:start`, "tool:run", `${stack}:end`]);
    });
    it.each(stacks)("preserves BLOCK behavior with %s-style wrapper on both wrapper orders", async (stack) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                decision: "BLOCK",
                reason: "blocked by policy",
                violation_id: "vio-compat-ts-001",
            }),
        }));
        const calledOuter = { value: false };
        const eventsOuter = [];
        const baseOuter = makeBaseTool(eventsOuter, calledOuter);
        const wrappedBeforeInstrument = wrapObservabilityLike(stack, eventsOuter, baseOuter);
        const thothOuter = new CompatAgent(wrappedBeforeInstrument);
        instrument(thothOuter, {
            agentId: `${stack}-thoth-outer`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        await expect(thothOuter.tools[0].run("incident-42")).rejects.toThrow(ThothPolicyViolation);
        expect(calledOuter.value).toBe(false);
        expect(eventsOuter).toEqual([]);
        const calledInner = { value: false };
        const eventsInner = [];
        const baseInner = makeBaseTool(eventsInner, calledInner);
        const thothInner = new CompatAgent(baseInner);
        instrument(thothInner, {
            agentId: `${stack}-thoth-inner`,
            approvedScope: ["search:docs"],
            tenantId: "trantor",
            apiUrl,
        });
        thothInner.tools[0].run = wrapObservabilityLike(stack, eventsInner, thothInner.tools[0].run.bind(thothInner.tools[0]));
        await expect(thothInner.tools[0].run("incident-42")).rejects.toThrow(ThothPolicyViolation);
        expect(calledInner.value).toBe(false);
        expect(eventsInner).toEqual([`${stack}:start`, `${stack}:error`]);
    });
});
//# sourceMappingURL=compatibility.test.js.map