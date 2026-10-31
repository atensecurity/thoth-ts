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
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { claimCheckedCall, claimCheckedMcpCall, openSession, } from "./instrumentor.js";
import { ThothPolicyViolation } from "./models.js";
import { jsonSchemaOf } from "./integrations/govern.js";
// Sessions named by the caller (actingFor(..., { sessionId })), kept so a
// later request resuming one continues its tool-call history. Oldest dropped first.
const MAX_NAMED_SESSIONS = 10000;
let runtime;
let undoHooks = [];
const actors = new AsyncLocalStorage();
// The call being run: the original, with exactly the arguments Thoth checked.
const running = new AsyncLocalStorage();
function setting(value, variable) {
    const resolved = (value ||
        (typeof process !== "undefined" ? process.env?.[variable] : undefined) ||
        "").trim();
    if (!resolved) {
        throw new Error(`init() needs ${variable} (or pass it as an option)`);
    }
    return resolved;
}
/** Loads an optional framework, or undefined when it isn't installed. */
async function load(specifier) {
    try {
        return (await import(
        /* webpackIgnore: true */ /* @vite-ignore */ specifier));
    }
    catch {
        return undefined;
    }
}
/** Governs every tool of the supported frameworks installed in this process. */
export async function init(options = {}) {
    shutdown();
    const config = {
        ...options,
        agentId: setting(options.agentId, "THOTH_AGENT_ID"),
        tenantId: setting(options.tenantId, "THOTH_TENANT_ID"),
        approvedScope: options.approvedScope ?? [],
    };
    runtime = {
        config,
        fallback: { userId: config.userId, session: openSession(config) },
        named: new Map(),
        reported: new Set(),
        governed: new WeakMap(),
    };
    const installed = [];
    for (const [name, install] of Object.entries(HOOKS)) {
        const undo = await install();
        if (undo) {
            undoHooks.push(undo);
            installed.push(name);
        }
    }
    return installed;
}
/** Removes every hook init() installed. Tools run ungoverned afterwards. */
export function shutdown() {
    for (const undo of undoHooks.reverse())
        undo();
    undoHooks = [];
    runtime = undefined;
}
/**
 * Runs `fn` with governed tools acting for `userId`, in one session. Without a
 * `sessionId` the block has its own session; with one, blocks naming the same
 * session for the same user share its tool-call history.
 */
export function actingFor(userId, fn, options = {}) {
    if (!runtime)
        throw new Error("actingFor() needs init() first");
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("actingFor() needs the user the agent is acting for");
    }
    return actors.run({ userId, session: sessionFor(runtime, userId, options.sessionId) }, fn);
}
/**
 * The session ID Thoth sees for a caller-named session. The caller's ID is
 * only unique within one user's sessions, so two users naming the same ID
 * must never share a session in Thoth: the ID sent is derived from the
 * tenant, agent, user and the caller's ID. It is stable across processes, so
 * a later request resuming the session continues it, and the Python SDK
 * derives the same ID.
 */
export function namedSessionId(config, userId, sessionId) {
    const hex = createHash("sha256")
        .update([
        "thoth-named-session-v1",
        config.tenantId,
        config.agentId,
        userId,
        sessionId,
    ].join("\u0000"))
        .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function sessionFor(rt, userId, sessionId) {
    const config = { ...rt.config, userId };
    if (!sessionId)
        return openSession(config);
    // Keyed by user too, so one user's history never feeds another's decisions.
    const key = `${userId}\u0000${sessionId}`;
    let session = rt.named.get(key);
    if (session) {
        rt.named.delete(key);
    }
    else {
        session = openSession(config, {
            sessionId: namedSessionId(rt.config, userId, sessionId),
        });
    }
    rt.named.set(key, session);
    while (rt.named.size > MAX_NAMED_SESSIONS) {
        rt.named.delete(rt.named.keys().next().value);
    }
    return session;
}
/**
 * Checks one call with Thoth in the current actor's session, then runs it
 * with exactly the arguments Thoth checked. A refusal throws.
 */
function checkThenRun(rt, name, args, tool, run) {
    const actor = actors.getStore() ?? rt.fallback;
    if (!rt.reported.has(name)) {
        rt.reported.add(name);
        actor.session.report([
            {
                name,
                description: typeof tool.description === "string" ? tool.description : "",
                inputSchema: jsonSchemaOf(tool.schema),
            },
        ]);
    }
    let governed = rt.governed.get(actor.session);
    if (!governed) {
        governed = new Map();
        rt.governed.set(actor.session, governed);
    }
    let wrapped = governed.get(name);
    if (!wrapped) {
        wrapped = actor.session.wrap(name, (checked) => {
            const current = running.getStore();
            if (!current)
                throw new ThothPolicyViolation(name, "the call can't be checked, so it was not run");
            return current(checked);
        });
        governed.set(name, wrapped);
    }
    const call = wrapped;
    return running.run(run, () => Promise.resolve(call(args)));
}
function isToolCall(input) {
    return (typeof input === "object" &&
        input !== null &&
        input.type === "tool_call" &&
        typeof input.args === "object");
}
async function installLangChain() {
    const tools = await load("@langchain/core/tools");
    const StructuredTool = tools?.StructuredTool;
    const original = StructuredTool?.prototype?.call;
    if (!StructuredTool || typeof original !== "function")
        return undefined;
    StructuredTool.prototype.call = function (arg, ...rest) {
        const rt = runtime;
        if (!rt)
            return original.call(this, arg, ...rest);
        const name = this.name;
        const input = isToolCall(arg) ? arg.args : arg;
        // String tools (Tool, DynamicTool) are checked as { input }.
        const textual = typeof input === "string";
        const args = textual ? { input } : input;
        if (typeof name !== "string" ||
            !name ||
            typeof args !== "object" ||
            args === null) {
            return Promise.reject(new ThothPolicyViolation(String(name ?? ""), "the call can't be checked, so it was not run"));
        }
        // A governed wrapper's own call goes through once, exactly as checked.
        if (claimCheckedCall(name, args))
            return original.call(this, arg, ...rest);
        return checkThenRun(rt, name, args, this, (checked) => {
            const value = textual ? checked.input : checked;
            return original.call(this, isToolCall(arg) ? { ...arg, args: value } : value, ...rest);
        });
    };
    return () => {
        StructuredTool.prototype.call = original;
    };
}
// --- MCP client --------------------------------------------------------------
async function installMcpClient() {
    const client = await load("@modelcontextprotocol/sdk/client/index.js");
    const Client = client?.Client;
    const original = Client?.prototype?.callTool;
    if (!Client || typeof original !== "function")
        return undefined;
    Client.prototype.callTool = function (params, ...rest) {
        const rt = runtime;
        if (!rt)
            return original.call(this, params, ...rest);
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (typeof name !== "string" ||
            !name ||
            typeof args !== "object" ||
            args === null) {
            return Promise.reject(new ThothPolicyViolation(String(name ?? ""), "the call can't be checked, so it was not sent"));
        }
        if (claimCheckedMcpCall(name, args))
            return original.call(this, params, ...rest);
        return checkThenRun(rt, name, args, {}, (checked) => 
        // Exactly the arguments Thoth checked are sent to the server.
        original.call(this, { ...params, arguments: checked }, ...rest));
    };
    return () => {
        Client.prototype.callTool = original;
    };
}
const HOOKS = {
    langchain: installLangChain,
    mcp_client: installMcpClient,
};
//# sourceMappingURL=auto.js.map