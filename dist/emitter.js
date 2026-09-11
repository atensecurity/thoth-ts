import { telemetryEvent } from "./telemetry.js";
const BATCH_ENDPOINT_SUFFIX = "/v1/events/batch";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function emitBehavioralEvent(event, apiUrl, apiKey, options = {}) {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
    if (!apiKey) {
        console.error("thoth: apiKey missing; dropping telemetry event_id=%s", event.eventId);
        return { eventId: event.eventId, state: "dropped", attempts: 0 };
    }
    const endpoint = `${apiUrl.replace(/\/$/, "")}${BATCH_ENDPOINT_SUFFIX}`;
    const body = JSON.stringify({ events: [telemetryEvent(event)] });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "X-Api-Key": apiKey,
                },
                body,
                signal: AbortSignal.timeout(5000),
            });
            await response.body?.cancel();
            if (response.ok) {
                return { eventId: event.eventId, state: "delivered", attempts: attempt };
            }
            const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            if (!retryable || attempt === maxAttempts) {
                console.warn("thoth: telemetry ingest rejected; dropping event_id=%s status=%s attempts=%s", event.eventId, response.status, attempt);
                return { eventId: event.eventId, state: "dropped", attempts: attempt };
            }
        }
        catch {
            if (attempt === maxAttempts) {
                console.error("thoth: telemetry ingest failure; dropping event_id=%s attempts=%s", event.eventId, attempt);
                return { eventId: event.eventId, state: "dropped", attempts: attempt };
            }
        }
        await delay(retryDelayMs * attempt);
    }
    return { eventId: event.eventId, state: "dropped", attempts: maxAttempts };
}
//# sourceMappingURL=emitter.js.map