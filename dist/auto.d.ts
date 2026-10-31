/**
 * One-call instrumentation: `init()`.
 *
 * Call it once at startup. It reads the connection from the environment and
 * governs every tool of each supported framework installed in the process,
 * at the one place that framework runs tools, so no tool is wrapped and
 * nothing is passed per call:
 *
 * ```typescript
 * import { init, actingFor } from "@atensec/thoth";
 *
 * await init(); // THOTH_API_KEY, THOTH_API_URL, THOTH_TENANT_ID, THOTH_AGENT_ID
 *
 * app.post("/chat", (req, res) =>
 *   actingFor(req.user.email, () => agent.invoke({ messages: req.body.messages })),
 * );
 * ```
 *
 * Frameworks governed:
 *
 * - LangChain.js and LangGraph.js tools, at `StructuredTool.prototype.call`,
 *   which `invoke` and every built-in tool class go through, including the
 *   tools LangGraph.js's ToolNode runs. A refusal throws ThothPolicyViolation.
 * - MCP clients (`@modelcontextprotocol/sdk`), at `Client.prototype.callTool`.
 *   A call a governed framework tool already checked (the same arguments,
 *   under the MCP tool's name or a prefixed form of it) isn't checked twice.
 *   A refusal rejects with ThothPolicyViolation and nothing is sent.
 *
 * Frameworks whose tools are plain objects or functions (the AI SDK, OpenAI
 * Agents, Mastra, Genkit, the Claude Agent SDK) have no shared method to
 * hook: govern them with their `govern*` function.
 *
 * `init()` patches the copy of each framework that Node resolves from this
 * package. An app bundled so that it carries its own copy (some Next.js and
 * edge builds) isn't governed by it; use the `govern*` functions there.
 *
 * Every call is sent to Thoth before the tool runs, and the server decides:
 * whether the agent observes or enforces is set there, per agent, never here.
 */
import { type ThothConfig } from "./models.js";
/** What init() reads from the environment, and anything to set in code instead. */
export type InitOptions = Partial<ThothConfig>;
/** Governs every tool of the supported frameworks installed in this process. */
export declare function init(options?: InitOptions): Promise<string[]>;
/** Removes every hook init() installed. Tools run ungoverned afterwards. */
export declare function shutdown(): void;
/**
 * Runs `fn` with governed tools acting for `userId`, in one session. Without a
 * `sessionId` the block has its own session; with one, blocks naming the same
 * session for the same user share its tool-call history.
 */
export declare function actingFor<T>(userId: string, fn: () => T, options?: {
    sessionId?: string;
}): T;
/**
 * The session ID Thoth sees for a caller-named session. The caller's ID is
 * only unique within one user's sessions, so two users naming the same ID
 * must never share a session in Thoth: the ID sent is derived from the
 * tenant, agent, user and the caller's ID. It is stable across processes, so
 * a later request resuming the session continues it, and the Python SDK
 * derives the same ID.
 */
export declare function namedSessionId(config: Pick<ThothConfig, "tenantId" | "agentId">, userId: string, sessionId: string): string;
//# sourceMappingURL=auto.d.ts.map