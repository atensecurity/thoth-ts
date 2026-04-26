/**
 * HTTP emitter for behavioral events.
 * POSTs events to the Aten-hosted API. Fire-and-forget; never blocks tool execution.
 */
import type { BehavioralEvent } from "./models";

const BATCH_ENDPOINT_SUFFIX = "/v1/events/batch";
const MAX_ERROR_BODY_CHARS = 512;

export async function emitBehavioralEvent(
  event: BehavioralEvent,
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  if (!apiKey) {
    console.error(
      "thoth: apiKey missing; dropping telemetry event_id=%s",
      event.eventId,
    );
    return;
  }
  try {
    const endpoint = `${apiUrl.replace(/\/$/, "")}${BATCH_ENDPOINT_SUFFIX}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      let responseBody = "";
      try {
        responseBody = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch (readError) {
        responseBody = `<read_error:${String(readError)}>`;
      }
      console.warn(
        "thoth: telemetry ingest rejected; dropping event_id=%s status=%s url=%s body=%s",
        event.eventId,
        response.status,
        endpoint,
        responseBody,
      );
    }
  } catch (error) {
    console.error(
      "thoth: telemetry ingest failure; dropping event_id=%s",
      event.eventId,
      error,
    );
  }
}
