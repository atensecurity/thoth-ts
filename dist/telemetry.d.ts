import { type BehavioralEvent } from "./models.js";
/** Allowlisted wire representation. Identifiers and policy codes must be opaque,
 * non-sensitive values supplied by the application/enforcer (see PRIVACY.md).
 * Never spread untrusted metadata or nested objects into the serialized event.
 */
export declare function telemetryEvent(event: BehavioralEvent): BehavioralEvent;
//# sourceMappingURL=telemetry.d.ts.map