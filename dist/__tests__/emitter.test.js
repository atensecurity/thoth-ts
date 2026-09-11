import { afterEach, describe, expect, it, vi } from "vitest";
import { EnforcementMode, EventType, SourceType, } from "../models.js";
import { emitBehavioralEvent } from "../emitter.js";
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
    it("retries transient failures with a stable event ID and reports delivery", async () => {
        const bodies = [];
        const fetchMock = vi.fn().mockImplementation((_url, init) => {
            bodies.push(String(init.body));
            return Promise.resolve({ ok: bodies.length === 3, status: bodies.length === 3 ? 202 : 503 });
        });
        vi.stubGlobal("fetch", fetchMock);
        const status = await emitBehavioralEvent(sampleEvent(), "https://example.test", "test-key", { maxAttempts: 3, retryDelayMs: 0 });
        expect(status).toEqual({ eventId: "evt_123", state: "delivered", attempts: 3 });
        expect(bodies).toHaveLength(3);
        expect(bodies.map((body) => JSON.parse(body).events[0].eventId)).toEqual([
            "evt_123", "evt_123", "evt_123",
        ]);
    });
    it("reports dropped after bounded transport retries", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
        vi.spyOn(console, "error").mockImplementation(() => { });
        const status = await emitBehavioralEvent(sampleEvent(), "https://example.test", "test-key", { maxAttempts: 2, retryDelayMs: 0 });
        expect(status).toEqual({ eventId: "evt_123", state: "dropped", attempts: 2 });
    });
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
        await expect(emitBehavioralEvent(sampleEvent(), "https://enforce.trantor.atensecurity.com", "aten_thoth_dev_testkey")).resolves.toEqual({ eventId: "evt_123", state: "dropped", attempts: 3 });
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
describe("telemetry privacy boundary", () => {
    it("drops unknown content and metadata without calling their serializers", async () => {
        const toJSON = vi.fn(() => "synthetic-secret");
        const event = sampleEvent();
        event.content = "synthetic-secret";
        event.taskContext = { toJSON };
        event.metadata = {
            tool_args: { toJSON },
            tool_call: { arguments: { toJSON } },
            unknown: { toJSON },
            purpose: "synthetic-secret",
            receipt: { payload: { toJSON }, decision_id: "decision-123" },
            risk_score: 92,
            model_signals: ["classification:phi", "dlp_redactions:2", "patient:synthetic-secret"],
            matched_rule_ids: ["rule-123", { toJSON }],
            latency_ms: Infinity,
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);
        await emitBehavioralEvent(event, "http://localhost", "synthetic-key");
        const raw = String(fetchMock.mock.calls[0][1].body);
        expect(raw).not.toContain("synthetic-secret");
        expect(toJSON).not.toHaveBeenCalled();
        const sent = JSON.parse(raw).events[0];
        expect(sent.metadata.risk_score).toBe(92);
        expect(sent.metadata.decision_id).toBe("decision-123");
        expect(sent.metadata.model_signals).toEqual(["classification:phi", "dlp_redactions:2"]);
        expect(sent.metadata.matched_rule_ids).toEqual(["rule-123"]);
        expect(sent.metadata.latency_ms).toBeUndefined();
        expect(event.content).toBe("synthetic-secret");
        expect(event.metadata.tool_args).toEqual({ toJSON });
    });
});
it("retains categorical threat evidence consumed by governance reports", async () => {
    const signals = [
        "threat:prompt_injection", "threat:prompt_injection_pattern:0.80",
        "threat:tool_output_poisoning:0.90", "moses_risk:prompt_injection",
        "moses_risk_classification:sensitive_information_disclosure",
        "moses_risk_conf:improper_output_handling:0.95", "fastml:unavailable",
        "attestation:missing", "moses_schema_guardrail:triggered",
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await emitBehavioralEvent({ ...sampleEvent(), metadata: { model_signals: [
                ...signals, "threat:patient-secret", "threat:prompt_injection:patient-secret",
                "moses_risk:patient-secret", "moses_risk_conf:prompt_injection:patient-secret",
            ] } }, "http://localhost", "synthetic-key");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).events[0].metadata.model_signals).toEqual(signals);
});
//# sourceMappingURL=emitter.test.js.map