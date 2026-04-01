/**
 * HTTP emitter for behavioral events.
 * POSTs events to the Aten-hosted API. Fire-and-forget; never blocks tool execution.
 */
import type { BehavioralEvent } from "./models";
export declare function emitBehavioralEvent(event: BehavioralEvent, apiUrl: string, apiKey: string): Promise<void>;
//# sourceMappingURL=emitter.d.ts.map