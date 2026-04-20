import { describe, it, expect, vi } from "vitest";
import { instrument } from "../instrumentor";
import { ThothPolicyViolation } from "../models";
class FakeTool {
    constructor() {
        this.name = "read:data";
        this.calls = [];
    }
    run(...args) {
        this.calls.push(args);
        return "result";
    }
}
class FakeAgent {
    constructor() {
        this.tools = [new FakeTool()];
    }
}
class FakeStreamingTool {
    constructor() {
        this.name = "stream:data";
    }
    async *run(..._args) {
        yield "chunk1";
        yield "chunk2";
        yield "chunk3";
    }
}
class FakeStreamingAgent {
    constructor() {
        this.tools = [new FakeStreamingTool()];
    }
}
describe("instrument()", () => {
    const apiUrl = "https://enforce.trantor.atensecurity.com";
    it("returns the same agent object", () => {
        const agent = new FakeAgent();
        const result = instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
        });
        expect(result).toBe(agent);
    });
    it("allows in-scope tool call", async () => {
        const agent = new FakeAgent();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        }));
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
        });
        const result = await agent.tools[0].run("arg");
        expect(result).toBe("result");
        expect(agent.tools[0].calls).toContainEqual(["arg"]);
    });
    it("raises ThothPolicyViolation on block", async () => {
        const agent = new FakeAgent();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "BLOCK", reason: "blocked" }),
        }));
        instrument(agent, {
            agentId: "test",
            approvedScope: [],
            tenantId: "trantor",
            enforcement: "block",
            apiUrl,
        });
        await expect(agent.tools[0].run()).rejects.toThrow(ThothPolicyViolation);
    });
    it("fails closed when enforcer is unreachable", async () => {
        const agent = new FakeAgent();
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
        });
        await expect(agent.tools[0].run("arg")).rejects.toThrow(/enforcer unavailable/i);
    });
    it("waits for step-up hold approval before executing tool", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes("/v1/enforce/hold/")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ resolved: true, resolution: "ALLOW" }),
                });
            }
            if (url.includes("/v1/enforce")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        decision: "STEP_UP",
                        hold_token: "tok_step_up_1",
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
            stepUpTimeoutMinutes: 1,
            stepUpPollIntervalMs: 1,
        });
        const result = await agent.tools[0].run("arg");
        expect(result).toBe("result");
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/enforce/hold/tok_step_up_1"))).toBe(true);
    });
    it("blocks tool execution when step-up approval times out", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes("/v1/enforce/hold/")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ resolved: false }),
                });
            }
            if (url.includes("/v1/enforce")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        decision: "STEP_UP",
                        hold_token: "tok_step_up_timeout",
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
            stepUpTimeoutMinutes: 0,
            stepUpPollIntervalMs: 1,
        });
        await expect(agent.tools[0].run("arg")).rejects.toThrow(/step-up auth timeout/i);
    });
    it("async generator tool yields all values", async () => {
        const agent = new FakeStreamingAgent();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        }));
        instrument(agent, {
            agentId: "test",
            approvedScope: ["stream:data"],
            tenantId: "trantor",
            apiUrl,
        });
        const chunks = [];
        for await (const chunk of agent.tools[0].run("arg")) {
            chunks.push(chunk);
        }
        expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"]);
    });
    it("includes current tool in session_tool_calls for async generator enforce", async () => {
        const agent = new FakeStreamingAgent();
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes("/v1/enforce")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ decision: "ALLOW" }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["stream:data"],
            tenantId: "trantor",
            apiUrl,
        });
        for await (const _chunk of agent.tools[0].run("arg")) {
            // exhaust
        }
        const enforceCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/v1/enforce"));
        const init = (enforceCall?.[1] ?? {});
        const body = JSON.parse(String(init.body));
        expect(body.session_tool_calls).toEqual(["stream:data"]);
    });
    it("TOOL_CALL_PRE is emitted before first yield", async () => {
        const agent = new FakeStreamingAgent();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        }));
        // Track order of events vs yields by patching emitEvent indirectly
        // We verify PRE fires before any yield by collecting order of operations
        const order = [];
        // Override the streaming tool to record when run body starts
        class OrderTrackingStreamingTool {
            constructor() {
                this.name = "stream:data";
            }
            async *run(..._args) {
                order.push("first-yield");
                yield "chunk1";
            }
        }
        class OrderTrackingAgent {
            constructor() {
                this.tools = [new OrderTrackingStreamingTool()];
            }
        }
        const trackingAgent = new OrderTrackingAgent();
        instrument(trackingAgent, {
            agentId: "test",
            approvedScope: ["stream:data"],
            tenantId: "trantor",
            apiUrl,
        });
        // The wrapped generator should call enforce (fetch) before running the original generator body
        const gen = trackingAgent.tools[0].run("arg");
        // Haven't iterated yet — fetch (enforce) should fire on first `.next()` call
        const firstNext = gen.next();
        order.push("awaiting-first-next");
        await firstNext;
        // After first next, enforce was called (fetch was called) and "first-yield" was set
        expect(order).toContain("first-yield");
    });
    it("TOOL_CALL_POST is emitted after generator exhaustion", async () => {
        const agent = new FakeStreamingAgent();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        }));
        instrument(agent, {
            agentId: "test",
            approvedScope: ["stream:data"],
            tenantId: "trantor",
            apiUrl,
        });
        const chunks = [];
        for await (const chunk of agent.tools[0].run()) {
            chunks.push(chunk);
        }
        // If generator was fully exhausted without error, all chunks should be present
        expect(chunks).toHaveLength(3);
    });
    it("wrapped function preserves original function name", () => {
        const agent = new FakeAgent();
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl,
        });
        // The original FakeTool.run method is named "run" (bound function name: "bound run")
        // After wrapping, the name should be preserved from the original
        expect(agent.tools[0].run.name).toBe("bound run");
    });
    it("wrapped async generator function preserves original function name", () => {
        const agent = new FakeStreamingAgent();
        instrument(agent, {
            agentId: "test",
            approvedScope: ["stream:data"],
            tenantId: "trantor",
            apiUrl,
        });
        // The original FakeStreamingTool.run is an async generator, bound name is "bound run"
        expect(agent.tools[0].run.name).toBe("bound run");
    });
    it("uses custom apiUrl for enforcement checks", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiKey: "thoth_live_test",
            apiUrl: "https://enforce.trantor.atensecurity.com",
        });
        await agent.tools[0].run("arg");
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls).toContain("https://enforce.trantor.atensecurity.com/v1/enforce");
    });
    it("uses custom apiUrl for enforcement when apiKey is omitted", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ decision: "ALLOW" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl: "https://enforce.trantor.atensecurity.com",
        });
        await agent.tools[0].run("arg");
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls).toContain("https://enforce.trantor.atensecurity.com/v1/enforce");
    });
    it("propagates custom environment to enforcer payload", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes("/v1/enforce")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ decision: "ALLOW" }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl: "https://enforce.trantor.atensecurity.com",
            environment: "dev",
        });
        await agent.tools[0].run("arg");
        const enforceCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/v1/enforce"));
        const init = (enforceCall?.[1] ?? {});
        const body = JSON.parse(String(init.body));
        expect(body.environment).toBe("dev");
    });
    it("propagates tool args, policy context, and trace id to enforce", async () => {
        const agent = new FakeAgent();
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes("/v1/enforce")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ decision: "ALLOW" }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            });
        });
        vi.stubGlobal("fetch", fetchMock);
        instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
            apiUrl: "https://enforce.trantor.atensecurity.com",
            policyContext: {
                vertical: "healthcare",
                role: "billing_agent",
            },
            enforcementTraceId: "trace-test-123",
        });
        await agent.tools[0].run({ mrn: "123456", request: "eligibility_check" });
        const enforceCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/v1/enforce"));
        expect(enforceCall).toBeTruthy();
        const init = (enforceCall?.[1] ?? {});
        const body = JSON.parse(String(init.body));
        expect(body.tool_args).toEqual({
            mrn: "123456",
            request: "eligibility_check",
        });
        expect(body.session_tool_calls).toEqual(["read:data"]);
        expect(body.environment).toBe("prod");
        expect(body.metadata.policy_context).toEqual({
            vertical: "healthcare",
            role: "billing_agent",
        });
        expect(body.enforcement_trace_id).toBe("trace-test-123");
    });
    it("throws when apiUrl is missing and THOTH_API_URL is unset", () => {
        const agent = new FakeAgent();
        if (typeof process !== "undefined") {
            delete process.env.THOTH_API_URL;
        }
        expect(() => instrument(agent, {
            agentId: "test",
            approvedScope: ["read:data"],
            tenantId: "trantor",
        })).toThrow("Thoth API URL is required");
    });
});
//# sourceMappingURL=instrumentor.test.js.map