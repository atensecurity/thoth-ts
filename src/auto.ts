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

import {
  claimCheckedCall,
  claimCheckedMcpCall,
  openSession,
  runActingFor,
  type GovernedSession,
} from "./instrumentor.js";

export { namedSessionId } from "./instrumentor.js";
import { ThothPolicyViolation, type ThothConfig } from "./models.js";
import { jsonSchemaOf } from "./integrations/govern.js";

/** What init() reads from the environment, and anything to set in code instead. */
export type InitOptions = Partial<ThothConfig>;

interface Runtime {
  config: ThothConfig;
  /** Opened with no userId, so calls in an actingFor block run as that user. */
  session: GovernedSession;
  reported: Set<string>;
  governed: Map<string, (...args: unknown[]) => unknown>;
}

let runtime: Runtime | undefined;
let undoHooks: (() => void)[] = [];
// The call being run: the original, with exactly the arguments Thoth checked.
const running = new AsyncLocalStorage<(checked: unknown) => unknown>();

function setting(value: string | undefined, variable: string): string {
  const resolved = (
    value ||
    (typeof process !== "undefined" ? process.env?.[variable] : undefined) ||
    ""
  ).trim();
  if (!resolved) {
    throw new Error(`init() needs ${variable} (or pass it as an option)`);
  }
  return resolved;
}

/** Loads an optional framework, or undefined when it isn't installed. */
async function load(
  specifier: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(
      /* webpackIgnore: true */ /* @vite-ignore */ specifier
    )) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Governs every tool of the supported frameworks installed in this process. */
export async function init(options: InitOptions = {}): Promise<string[]> {
  shutdown();
  const config: ThothConfig = {
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
  const installed: string[] = [];
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
export function shutdown(): void {
  for (const undo of undoHooks.reverse()) undo();
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
export function actingFor<T>(
  userId: string,
  fn: () => T,
  options: { sessionId?: string } = {},
): T {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("actingFor() needs the user the agent is acting for");
  }
  return runActingFor(userId, options.sessionId, fn);
}

/**
 * Checks one call with Thoth (as the actingFor user, when there is one), then
 * runs it with exactly the arguments Thoth checked. A refusal throws.
 */
function checkThenRun(
  rt: Runtime,
  name: string,
  args: unknown,
  tool: { description?: unknown; schema?: unknown },
  run: (checked: unknown) => unknown,
): Promise<unknown> {
  if (!rt.reported.has(name)) {
    rt.reported.add(name);
    rt.session.report([
      {
        name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: jsonSchemaOf(tool.schema),
      },
    ]);
  }
  let wrapped = rt.governed.get(name);
  if (!wrapped) {
    wrapped = rt.session.wrap(name, (checked: unknown) => {
      const current = running.getStore();
      if (!current)
        throw new ThothPolicyViolation(
          name,
          "the call can't be checked, so it was not run",
        );
      return current(checked);
    });
    rt.governed.set(name, wrapped);
  }
  const call = wrapped;
  return running.run(run, () => Promise.resolve(call(args)));
}

// --- LangChain.js -----------------------------------------------------------

interface ToolCallInput {
  type: "tool_call";
  args: Record<string, unknown>;
}

function isToolCall(input: unknown): input is ToolCallInput {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { type?: unknown }).type === "tool_call" &&
    typeof (input as { args?: unknown }).args === "object"
  );
}

async function installLangChain(): Promise<(() => void) | undefined> {
  const tools = await load("@langchain/core/tools");
  const StructuredTool = tools?.StructuredTool as
    | { prototype: { call: (...args: unknown[]) => Promise<unknown> } }
    | undefined;
  const original = StructuredTool?.prototype?.call;
  if (!StructuredTool || typeof original !== "function") return undefined;

  StructuredTool.prototype.call = function (
    this: { name?: unknown; description?: unknown; schema?: unknown },
    arg: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const rt = runtime;
    if (!rt) return original.call(this, arg, ...rest);
    const name = this.name;
    const input = isToolCall(arg) ? arg.args : arg;
    // String tools (Tool, DynamicTool) are checked as { input }.
    const textual = typeof input === "string";
    const args = textual ? { input } : input;
    if (
      typeof name !== "string" ||
      !name ||
      typeof args !== "object" ||
      args === null
    ) {
      return Promise.reject(
        new ThothPolicyViolation(
          String(name ?? ""),
          "the call can't be checked, so it was not run",
        ),
      );
    }
    // A governed wrapper's own call goes through once, exactly as checked.
    if (claimCheckedCall(name, args)) return original.call(this, arg, ...rest);
    return checkThenRun(rt, name, args, this, (checked) => {
      const value = textual ? (checked as { input?: unknown }).input : checked;
      return original.call(
        this,
        isToolCall(arg) ? { ...arg, args: value } : value,
        ...rest,
      );
    });
  };

  return () => {
    StructuredTool.prototype.call = original;
  };
}

// --- MCP client --------------------------------------------------------------

async function installMcpClient(): Promise<(() => void) | undefined> {
  const client = await load("@modelcontextprotocol/sdk/client/index.js");
  const Client = client?.Client as
    | { prototype: { callTool: (...args: unknown[]) => Promise<unknown> } }
    | undefined;
  const original = Client?.prototype?.callTool;
  if (!Client || typeof original !== "function") return undefined;

  Client.prototype.callTool = function (
    this: unknown,
    params: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const rt = runtime;
    if (!rt) return original.call(this, params, ...rest);
    const name = (params as { name?: unknown } | undefined)?.name;
    const args =
      (params as { arguments?: unknown } | undefined)?.arguments ?? {};
    if (
      typeof name !== "string" ||
      !name ||
      typeof args !== "object" ||
      args === null
    ) {
      return Promise.reject(
        new ThothPolicyViolation(
          String(name ?? ""),
          "the call can't be checked, so it was not sent",
        ),
      );
    }
    if (claimCheckedMcpCall(name, args))
      return original.call(this, params, ...rest);
    return checkThenRun(rt, name, args, {}, (checked) =>
      // Exactly the arguments Thoth checked are sent to the server.
      original.call(
        this,
        { ...(params as object), arguments: checked },
        ...rest,
      ),
    );
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
async function* streamChecked<Y, R>(
  rt: Runtime,
  name: string,
  args: unknown,
  tool: { description?: unknown; schema?: unknown },
  start: (checked: unknown) => AsyncGenerator<Y, R, unknown>,
): AsyncGenerator<Y, R, unknown> {
  const queue: { value: Y; ack: () => void }[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let stopped = false;
  // Set by the task's callbacks; read once the task has settled.
  const settled: {
    outcome: { ok: true; value: R } | { ok: false; error: unknown };
  } = {
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
        await stream.return?.(undefined as R);
        throw new Error("tool stream closed early");
      }
      const value = next.value;
      await new Promise<void>((ack) => {
        queue.push({ value, ack });
        notify();
      });
      next = await stream.next();
    }
    return next.value;
  }).then(
    (value) => {
      settled.outcome = { ok: true, value: value as R };
    },
    (error: unknown) => {
      settled.outcome = { ok: false, error };
    },
  );
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
      if (finished) break;
      await new Promise<void>((resume) => {
        wake = resume;
      });
    }
    await task;
    const { outcome } = settled;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    // A consumer that stops early (or throws) stops the tool too.
    stopped = true;
    for (const item of queue.splice(0)) item.ack();
  }
}

// --- Strands Agents ----------------------------------------------------------

interface StrandsToolUse {
  name?: unknown;
  toolUseId?: unknown;
  input?: unknown;
}

async function installStrands(): Promise<(() => void) | undefined> {
  const sdk = await load("@strands-agents/sdk");
  const Concurrent = sdk?.ConcurrentToolExecutor as
    | { prototype: object }
    | undefined;
  const Agent = sdk?.Agent as { prototype: object } | undefined;
  const ToolResultBlock = sdk?.ToolResultBlock as
    | (new (data: unknown) => unknown)
    | undefined;
  const TextBlock = sdk?.TextBlock as
    | (new (text: string) => unknown)
    | undefined;
  if (!Concurrent || !Agent || !ToolResultBlock || !TextBlock) return undefined;
  // The executors share one base class, which runs every agent-loop tool call.
  const executor = Object.getPrototypeOf(Concurrent.prototype) as {
    _executeToolCore?: (
      ...args: unknown[]
    ) => AsyncGenerator<unknown, unknown, unknown>;
  };
  const executeToolCore = executor._executeToolCore;
  const toolGetter = Object.getOwnPropertyDescriptor(
    Agent.prototype,
    "tool",
  )?.get;
  if (
    typeof executeToolCore !== "function" ||
    typeof toolGetter !== "function"
  ) {
    // A version without both entry points isn't governed at all, never halfway.
    return undefined;
  }

  const refusal = (toolUse: StrandsToolUse, reason: string) =>
    new ToolResultBlock({
      toolUseId: toolUse.toolUseId,
      status: "error",
      content: [new TextBlock(`Thoth refused this call: ${reason}`)],
    });

  /** Governs one call, given how to run it with a checked tool use. */
  async function* governed(
    tool: { description?: unknown; inputSchema?: unknown } | undefined,
    toolUse: StrandsToolUse,
    run: (checked: StrandsToolUse) => AsyncGenerator<unknown, unknown, unknown>,
  ): AsyncGenerator<unknown, unknown, unknown> {
    const rt = runtime;
    if (!rt || !tool) return yield* run(toolUse);
    const name = toolUse.name;
    const args = toolUse.input ?? {};
    if (
      typeof name !== "string" ||
      !name ||
      typeof args !== "object" ||
      args === null
    ) {
      return refusal(toolUse, "the call can't be checked, so it was not run");
    }
    if (claimCheckedCall(name, args)) return yield* run(toolUse);
    try {
      return yield* streamChecked(
        rt,
        name,
        args,
        { description: tool.description, schema: tool.inputSchema },
        // Exactly the input Thoth checked.
        (checked) => run({ ...toolUse, input: checked }),
      );
    } catch (error) {
      if (error instanceof ThothPolicyViolation)
        return refusal(toolUse, error.reason);
      throw error;
    }
  }

  executor._executeToolCore = function (this: unknown, ...args: unknown[]) {
    const [options, effectiveTool, toolUse, ...rest] = args as [
      unknown,
      { description?: unknown; inputSchema?: unknown } | undefined,
      StrandsToolUse,
      ...unknown[],
    ];
    return governed(effectiveTool, toolUse, (checked) =>
      executeToolCore.call(this, options, effectiveTool, checked, ...rest),
    );
  };

  // Direct agent.tool.<name>() calls run through the agent's ToolCaller, which
  // isn't exported: its prototype is governed the first time a caller is seen.
  type ExecuteTool = (...args: unknown[]) => AsyncGenerator;
  const patched: {
    prototype?: { _executeTool?: ExecuteTool };
    original?: ExecuteTool;
  } = {};
  Object.defineProperty(Agent.prototype, "tool", {
    configurable: true,
    get(this: unknown) {
      const caller = toolGetter.call(this) as object;
      if (!patched.prototype && caller) {
        const prototype = Object.getPrototypeOf(caller) as {
          _executeTool?: ExecuteTool;
        } | null;
        const original = prototype?._executeTool;
        if (prototype && typeof original === "function") {
          patched.prototype = prototype;
          patched.original = original;
          prototype._executeTool = function (
            this: unknown,
            ...args: unknown[]
          ) {
            const [tool, toolContext] = args as [
              { description?: unknown; inputSchema?: unknown } | undefined,
              { toolUse: StrandsToolUse },
            ];
            return governed(
              tool,
              toolContext.toolUse,
              (checked) =>
                original.call(this, tool, {
                  ...toolContext,
                  toolUse: checked,
                }) as AsyncGenerator<unknown, unknown, unknown>,
            );
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

interface AdkTool {
  name?: unknown;
  description?: unknown;
  runAsync: (request: {
    args: unknown;
    toolContext: unknown;
  }) => Promise<unknown>;
  _getDeclaration?: () =>
    | { parameters?: unknown; parametersJsonSchema?: unknown }
    | undefined;
  [ADK_GOVERNED]?: true;
}

/** Governs one ADK tool instance's runAsync; a no-op once governed. */
function governAdkInstance(tool: AdkTool): void {
  if (!tool || typeof tool !== "object" || tool[ADK_GOVERNED]) return;
  const runAsync = tool.runAsync;
  if (typeof runAsync !== "function") return;
  // Set on the instance, so a subclass's own runAsync is governed too.
  Object.defineProperty(tool, "runAsync", {
    configurable: true,
    writable: true,
    value: function (
      this: AdkTool,
      request: { args: unknown; toolContext: unknown },
    ) {
      const rt = runtime;
      // After shutdown(), tools run as they did before init().
      if (!rt) return runAsync.call(this, request);
      const name = this.name;
      const args = request?.args ?? {};
      if (
        typeof name !== "string" ||
        !name ||
        typeof args !== "object" ||
        args === null
      ) {
        return Promise.reject(
          new ThothPolicyViolation(
            String(name ?? ""),
            "the call can't be checked, so it was not run",
          ),
        );
      }
      if (claimCheckedCall(name, args)) return runAsync.call(this, request);
      let schema: unknown;
      try {
        const declaration = this._getDeclaration?.();
        schema = declaration?.parametersJsonSchema ?? declaration?.parameters;
      } catch {
        // Advisory metadata must never affect governance.
      }
      return checkThenRun(
        rt,
        name,
        args,
        { description: this.description, schema },
        (checked) =>
          // Exactly the arguments Thoth checked; the tool context passes through.
          runAsync.call(this, { ...request, args: checked }),
      );
    },
  });
  Object.defineProperty(tool, ADK_GOVERNED, { value: true });
}

async function installGoogleAdk(): Promise<(() => void) | undefined> {
  const adk = await load("@google/adk");
  const LlmAgent = adk?.LlmAgent as
    | {
        prototype: {
          canonicalTools?: (...args: unknown[]) => Promise<unknown[]>;
        };
      }
    | undefined;
  const canonicalTools = LlmAgent?.prototype?.canonicalTools;
  if (!LlmAgent || typeof canonicalTools !== "function") return undefined;
  // Every tool an ADK agent can call comes from canonicalTools, so each is
  // governed there, whatever its class.
  LlmAgent.prototype.canonicalTools = async function (
    this: unknown,
    ...args: unknown[]
  ) {
    const tools = await canonicalTools.apply(this, args);
    if (runtime) for (const tool of tools) governAdkInstance(tool as AdkTool);
    return tools;
  };
  return () => {
    LlmAgent.prototype.canonicalTools = canonicalTools;
  };
}

const HOOKS: Record<string, () => Promise<(() => void) | undefined>> = {
  langchain: installLangChain,
  mcp_client: installMcpClient,
  strands: installStrands,
  google_adk: installGoogleAdk,
};
