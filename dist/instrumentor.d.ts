import { ThothConfig } from "./models.js";
/** True while a governed wrapper runs this tool, which Thoth already checked. */
export declare function alreadyGoverned(toolName: string): boolean;
export declare function instrument<T extends object>(agent: T, config: ThothConfig): T;
/** A tool as the inventory reads it. */
export interface InventoryTool {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    input_schema?: unknown;
}
/** One Thoth session that governs tools by name (openSession). */
export interface GovernedSession {
    readonly sessionId: string;
    /** Governs one tool's function: checked by Thoth before it runs. */
    wrap(toolName: string, run: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
    /** Sends tools' names and schemas to the tool inventory, in the background. */
    report(tools: InventoryTool[]): void;
}
/**
 * Opens one Thoth session. Every function it wraps shares the session's ID and
 * tool-call history, including tools first seen after it opens (an MCP
 * server's, for example). instrument() is a session wrapping an agent's tools.
 */
export declare function openSession(config: ThothConfig): GovernedSession;
//# sourceMappingURL=instrumentor.d.ts.map