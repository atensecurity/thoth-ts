import { ThothConfig } from "./models.js";
/**
 * True, once, when this is the exact call a governed wrapper already checked
 * and is running: the same tool and the same arguments. Every other call,
 * including a repeat of it, must be checked.
 */
export declare function claimCheckedCall(toolName: string, args: unknown): boolean;
/**
 * True, once, when this MCP call is the one a governed framework tool already
 * checked. Frameworks often expose an MCP tool under a prefixed name, so the
 * checked call may be named `<prefix><separator><toolName>`. The arguments
 * must be identical, and it is claimed once (owner decision, 31 October 2026:
 * a prefixed-name match, not a name-blind one).
 */
export declare function claimCheckedMcpCall(toolName: string, args: unknown): boolean;
/**
 * The API for trial and self-serve workspaces. Enterprise workspaces have
 * their own host and set it with config.apiUrl or THOTH_API_URL.
 */
export declare const DEFAULT_API_URL = "https://api.atensecurity.com";
export declare function instrument<T extends object>(agent: T, config: ThothConfig): T;
/** A tool as the inventory reads it. */
export interface InventoryTool {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    input_schema?: unknown;
}
/** Runs `fn` with governed calls acting for `userId`; see actingFor(). */
export declare function runActingFor<T>(userId: string, sessionId: string | undefined, fn: () => T): T;
/**
 * The session ID Thoth sees for a caller-named session. The caller's ID is
 * only unique within one user's sessions, so two users naming the same ID
 * must never share a session in Thoth: the ID sent is derived from the
 * tenant, agent, user and the caller's ID. It is stable across processes, so
 * a later request resuming the session continues it, and the Python SDK
 * derives the same ID.
 */
export declare function namedSessionId(config: Pick<ThothConfig, "tenantId" | "agentId">, userId: string, sessionId: string): string;
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
export declare function openSession(config: ThothConfig, options?: {
    sessionId?: string;
    toolCalls?: string[];
}): GovernedSession;
//# sourceMappingURL=instrumentor.d.ts.map