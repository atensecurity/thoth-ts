import { afterEach, describe, expect, it, vi } from "vitest";
import { EnforcementMode, EventType, SourceType, } from "../models";
import { emitBehavioralEvent } from "../emitter";
function sampleEvent() {
    return {
        eventId: "evt_123",
        tenantId: "trantor",
        agentId: "filesystem-safe",
        sessionId: "sess_123",
        userId: "ops@trantor.com",
        sourceType: SourceType.AGENT_TOOL_CALL,
        eventType: EventType.TOOL_CALL_POST,
        content: "tool call completed",
        approvedScope: ["read:docs"],
        enforcementMode: EnforcementMode.PROGRESSIVE,
        sessionToolCalls: ["read:docs"],
        occurredAt: new Date("2026-04-25T12:00:00Z"),
    };
}
afterEach(() => {
    vi.restoreAllMocks();
});
describe("emitBehavioralEvent", () => {
    it("sends both Authorization and X-Api-Key headers", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 202,
            text: () => Promise.resolve(""),
        });
        vi.stubGlobal("fetch", fetchMock);
        await emitBehavioralEvent(sampleEvent(), "https://enforce.trantor.atensecurity.com/", "aten_thoth_dev_testkey");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://enforce.trantor.atensecurity.com/v1/events/batch");
        expect(init.headers.Authorization).toBe("Bearer aten_thoth_dev_testkey");
        expect(init.headers["X-Api-Key"]).toBe("aten_thoth_dev_testkey");
    });
    it("logs warning on non-2xx ingest response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: () => Promise.resolve("forbidden"),
        });
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.stubGlobal("fetch", fetchMock);
        await emitBehavioralEvent(sampleEvent(), "https://enforce.trantor.atensecurity.com", "aten_thoth_dev_testkey");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain("telemetry ingest rejected");
    });
    it("logs error and does not throw on fetch failure", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValue(new Error("network unreachable"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        vi.stubGlobal("fetch", fetchMock);
        await expect(emitBehavioralEvent(sampleEvent(), "https://enforce.trantor.atensecurity.com", "aten_thoth_dev_testkey")).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=emitter.test.js.map