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
 * - Strands Agents tools, at the tool executor every agent-loop call runs
 *   through, and direct `agent.tool.<name>()` calls. The tool runs inside the
 *   check and its events still stream; a refusal ends the call with an error
 *   tool result, "Thoth refused this call: <reason>".
 * - Google ADK tools, each governed as `LlmAgent.canonicalTools()` hands it
 *   to the agent, so your own `BaseTool` subclasses are governed too. A
 *   refusal throws ThothPolicyViolation from `runAsync`.
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
import { claimCheckedCall, claimCheckedMcpCall, openSession, runActingFor, } from "./instrumentor.js";
export { namedSessionId } from "./instrumentor.js";
import { ThothPolicyViolation } from "./models.js";
import { jsonSchemaOf } from "./integrations/govern.js";
let runtime;
let undoHooks = [];
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
        session: openSession(config),
        reported: new Set(),
        governed: new Map(),
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
 *
 * It covers every governed tool given no `userId` of its own: those init()
 * governs, and those governed with instrument() or a `govern*` function. It
 * doesn't need init().
 */
export function actingFor(userId, fn, options = {}) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("actingFor() needs the user the agent is acting for");
    }
    return runActingFor(userId, options.sessionId, fn);
}
/**
 * Checks one call with Thoth (as the actingFor user, when there is one), then
 * runs it with exactly the arguments Thoth checked. A refusal throws.
 */
function checkThenRun(rt, name, args, tool, run) {
    if (!rt.reported.has(name)) {
        rt.reported.add(name);
        rt.session.report([
            {
                name,
                description: typeof tool.description === "string" ? tool.description : "",
                inputSchema: jsonSchemaOf(tool.schema),
            },
        ]);
    }
    let wrapped = rt.governed.get(name);
    if (!wrapped) {
        wrapped = rt.session.wrap(name, (checked) => {
            const current = running.getStore();
            if (!current)
                throw new ThothPolicyViolation(name, "the call can't be checked, so it was not run");
            return current(checked);
        });
        rt.governed.set(name, wrapped);
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
// --- Streaming tools ---------------------------------------------------------
/**
 * Runs a streaming tool inside its Thoth check and hands its events on as
 * they come. `start(checked)` starts the tool with exactly the arguments Thoth
 * checked; the whole stream runs inside the checked call, so Thoth records
 * the tool's real outcome after it ends. The tool and the consumer move in
 * lockstep: the tool waits until each event has been handed on and the next
 * one asked for, so events stream as they would without Thoth. A refusal
 * throws ThothPolicyViolation before any event; a consumer that stops early
 * stops the tool too.
 */
async function* streamChecked(rt, name, args, tool, start) {
    const queue = [];
    let wake;
    let finished = false;
    let stopped = false;
    // Set by the task's callbacks; read once the task has settled.
    const settled = {
        outcome: { ok: false, error: new Error("tool stream did not finish") },
    };
    const notify = () => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const task = checkThenRun(rt, name, args, tool, async (checked) => {
        const stream = start(checked);
        let next = await stream.next();
        while (!next.done) {
            if (stopped) {
                await stream.return?.(undefined);
                throw new Error("tool stream closed early");
            }
            const value = next.value;
            await new Promise((ack) => {
                queue.push({ value, ack });
                notify();
            });
            next = await stream.next();
        }
        return next.value;
    }).then((value) => {
        settled.outcome = { ok: true, value: value };
    }, (error) => {
        settled.outcome = { ok: false, error };
    });
    void task.finally(() => {
        finished = true;
        notify();
    });
    try {
        for (;;) {
            const item = queue.shift();
            if (item) {
                yield item.value;
                item.ack();
                continue;
            }
            if (finished)
                break;
            await new Promise((resume) => {
                wake = resume;
            });
        }
        await task;
        const { outcome } = settled;
        if (!outcome.ok)
            throw outcome.error;
        return outcome.value;
    }
    finally {
        // A consumer that stops early (or throws) stops the tool too.
        stopped = true;
        for (const item of queue.splice(0))
            item.ack();
    }
}
async function installStrands() {
    const sdk = await load("@strands-agents/sdk");
    const Concurrent = sdk?.ConcurrentToolExecutor;
    const Agent = sdk?.Agent;
    const ToolResultBlock = sdk?.ToolResultBlock;
    const TextBlock = sdk?.TextBlock;
    if (!Concurrent || !Agent || !ToolResultBlock || !TextBlock)
        return undefined;
    // The executors share one base class, which runs every agent-loop tool call.
    const executor = Object.getPrototypeOf(Concurrent.prototype);
    const executeToolCore = executor._executeToolCore;
    const toolGetter = Object.getOwnPropertyDescriptor(Agent.prototype, "tool")?.get;
    if (typeof executeToolCore !== "function" ||
        typeof toolGetter !== "function") {
        // A version without both entry points isn't governed at all, never halfway.
        return undefined;
    }
    const refusal = (toolUse, reason) => new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status: "error",
        content: [new TextBlock(`Thoth refused this call: ${reason}`)],
    });
    /** Governs one call, given how to run it with a checked tool use. */
    async function* governed(tool, toolUse, run) {
        const rt = runtime;
        if (!rt || !tool)
            return yield* run(toolUse);
        const name = toolUse.name;
        const args = toolUse.input ?? {};
        if (typeof name !== "string" ||
            !name ||
            typeof args !== "object" ||
            args === null) {
            return refusal(toolUse, "the call can't be checked, so it was not run");
        }
        if (claimCheckedCall(name, args))
            return yield* run(toolUse);
        try {
            return yield* streamChecked(rt, name, args, { description: tool.description, schema: tool.inputSchema }, 
            // Exactly the input Thoth checked.
            (checked) => run({ ...toolUse, input: checked }));
        }
        catch (error) {
            if (error instanceof ThothPolicyViolation)
                return refusal(toolUse, error.reason);
            throw error;
        }
    }
    executor._executeToolCore = function (...args) {
        const [options, effectiveTool, toolUse, ...rest] = args;
        return governed(effectiveTool, toolUse, (checked) => executeToolCore.call(this, options, effectiveTool, checked, ...rest));
    };
    const patched = {};
    Object.defineProperty(Agent.prototype, "tool", {
        configurable: true,
        get() {
            const caller = toolGetter.call(this);
            if (!patched.prototype && caller) {
                const prototype = Object.getPrototypeOf(caller);
                const original = prototype?._executeTool;
                if (prototype && typeof original === "function") {
                    patched.prototype = prototype;
                    patched.original = original;
                    prototype._executeTool = function (...args) {
                        const [tool, toolContext] = args;
                        return governed(tool, toolContext.toolUse, (checked) => original.call(this, tool, {
                            ...toolContext,
                            toolUse: checked,
                        }));
                    };
                }
            }
            return caller;
        },
    });
    return () => {
        executor._executeToolCore = executeToolCore;
        Object.defineProperty(Agent.prototype, "tool", {
            configurable: true,
            get: toolGetter,
        });
        if (patched.prototype && patched.original) {
            patched.prototype._executeTool = patched.original;
        }
    };
}
// --- Google ADK --------------------------------------------------------------
const ADK_GOVERNED = Symbol.for("thoth.adk.governed");
/** Governs one ADK tool instance's runAsync; a no-op once governed. */
function governAdkInstance(tool) {
    if (!tool || typeof tool !== "object" || tool[ADK_GOVERNED])
        return;
    const runAsync = tool.runAsync;
    if (typeof runAsync !== "function")
        return;
    // Set on the instance, so a subclass's own runAsync is governed too.
    Object.defineProperty(tool, "runAsync", {
        configurable: true,
        writable: true,
        value: function (request) {
            const rt = runtime;
            // After shutdown(), tools run as they did before init().
            if (!rt)
                return runAsync.call(this, request);
            const name = this.name;
            const args = request?.args ?? {};
            if (typeof name !== "string" ||
                !name ||
                typeof args !== "object" ||
                args === null) {
                return Promise.reject(new ThothPolicyViolation(String(name ?? ""), "the call can't be checked, so it was not run"));
            }
            if (claimCheckedCall(name, args))
                return runAsync.call(this, request);
            let schema;
            try {
                const declaration = this._getDeclaration?.();
                schema = declaration?.parametersJsonSchema ?? declaration?.parameters;
            }
            catch {
                // Advisory metadata must never affect governance.
            }
            return checkThenRun(rt, name, args, { description: this.description, schema }, (checked) => 
            // Exactly the arguments Thoth checked; the tool context passes through.
            runAsync.call(this, { ...request, args: checked }));
        },
    });
    Object.defineProperty(tool, ADK_GOVERNED, { value: true });
}
async function installGoogleAdk() {
    const adk = await load("@google/adk");
    const LlmAgent = adk?.LlmAgent;
    const canonicalTools = LlmAgent?.prototype?.canonicalTools;
    if (!LlmAgent || typeof canonicalTools !== "function")
        return undefined;
    // Every tool an ADK agent can call comes from canonicalTools, so each is
    // governed there, whatever its class.
    LlmAgent.prototype.canonicalTools = async function (...args) {
        const tools = await canonicalTools.apply(this, args);
        if (runtime)
            for (const tool of tools)
                governAdkInstance(tool);
        return tools;
    };
    return () => {
        LlmAgent.prototype.canonicalTools = canonicalTools;
    };
}
const HOOKS = {
    langchain: installLangChain,
    mcp_client: installMcpClient,
    strands: installStrands,
    google_adk: installGoogleAdk,
};
//# sourceMappingURL=auto.js.map