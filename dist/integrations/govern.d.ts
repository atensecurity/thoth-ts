/**
 * The shared core of the framework integrations: governs a set of tool
 * `execute` functions with one Thoth session.
 *
 * Frameworks call a tool as `execute(input, ...extra)`, where `extra` is the
 * framework's own call details (a tool call ID, an abort signal, a run
 * context). Only `input` is sent to Thoth as the tool's arguments; `extra`
 * reaches the original function untouched, and is never serialized.
 */
import type { ThothConfig } from "../models.js";
export interface ToolSpec {
    name: string;
    description?: string;
    /** A JSON Schema, a Zod schema or an object exposing `jsonSchema`. */
    inputSchema?: unknown;
    execute: (input: unknown, ...extra: unknown[]) => unknown;
}
export type GovernedExecute = (input: unknown, ...extra: unknown[]) => Promise<unknown>;
/** The tool's input schema as JSON Schema for the tool inventory, or {}. */
export declare function jsonSchemaOf(schema: unknown): Record<string, unknown>;
/**
 * Returns a governed `execute` per tool name. Each call is checked by Thoth
 * before the original runs; a refusal throws ThothPolicyViolation and the
 * original never runs.
 */
export declare function governExecutes(tools: ToolSpec[], config: ThothConfig): Map<string, GovernedExecute>;
//# sourceMappingURL=govern.d.ts.map