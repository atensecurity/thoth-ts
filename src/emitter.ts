/**
 * HTTP emitter for behavioral events.
 * POSTs events to the Aten-hosted API. Fire-and-forget; never blocks tool execution.
 */
import type { BehavioralEvent } from "./models";

const BATCH_ENDPOINT_SUFFIX = "/v1/events/batch";

export async function emitBehavioralEvent(
  event: BehavioralEvent,
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  if (!apiKey) return; // silently skip if not configured
  try {
    await fetch(`${apiUrl.replace(/\/$/, "")}${BATCH_ENDPOINT_SUFFIX}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal: never block the agent due to telemetry failures
  }
}
