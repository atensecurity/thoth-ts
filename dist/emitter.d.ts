/**
 * HTTP emitter for behavioral events.
 * POSTs events to the Aten-hosted API. Fire-and-forget; never blocks tool execution.
 */
import type { BehavioralEvent } from "./models.js";
export interface DeliveryStatus {
    eventId: string;
    state: "delivered" | "dropped";
    attempts: number;
}
export interface DeliveryOptions {
    maxAttempts?: number;
    retryDelayMs?: number;
}
export declare function emitBehavioralEvent(event: BehavioralEvent, apiUrl: string, apiKey: string, options?: DeliveryOptions): Promise<DeliveryStatus>;
//# sourceMappingURL=emitter.d.ts.map