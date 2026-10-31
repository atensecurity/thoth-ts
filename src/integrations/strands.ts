/**
 * Strands Agents integration for @atensec/thoth.
 *
 * Governs a Strands agent's tools (`tool()`, MCP tools, vended tools): each
 * call is checked by Thoth when the tool runs, with the call's final input,
 * and the tool runs with exactly the input Thoth checked.
 *
 * Checking at the tool, rather than in a BeforeToolCallEvent hook, means a
 * hook registered after Thoth's can't change the input after the check.
 *
 * @example
 * ```typescript
 * import { Agent } from "@strands-agents/sdk";
 * import { governStrandsTools } from "@atensec/thoth/strands";
 *
 * const agent = new Agent({
 *   tools: governStrandsTools([listOrders, wireFunds], {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * await agent.invoke("What's open on A-1?");
 * ```
 *
 * A refused call never runs: the tool's stream throws ThothPolicyViolation,
 * which Strands reports to the model as the tool's error.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { openSession } from "../instrumentor.js";
import type { ThothConfig } from "../models.js";
import { jsonSchemaOf } from "./govern.js";

/** The parts of a Strands tool this integration uses. */
export interface StrandsToolLike {
  name: string;
  description?: string;
  toolSpec?: { inputSchema?: unknown };
  stream(toolContext: never): AsyncGenerator<unknown, unknown, unknown>;
}

interface ToolContextLike {
  toolUse: { input?: unknown } & Record<string, unknown>;
}

/** One call's state: set once Thoth allows it, settled when the tool ends. */
interface InFlight {
  allowed: (checked: unknown) => void;
  finish?: (result: unknown) => void;
  fail?: (error: unknown) => void;
}

/**
 * Returns governed copies of `tools`, in the same order, in one Thoth
 * session. The copies keep each tool's fields and class; the tools passed in
 * are unchanged, so govern them per agent or request.
 */
export function governStrandsTools<T extends StrandsToolLike>(
  tools: readonly T[],
  config: ThothConfig,
): T[] {
  const session = openSession(config);
  session.report(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: jsonSchemaOf(tool.toolSpec?.inputSchema),
    })),
  );
  return tools.map((tool) => {
    const stream = tool.stream.bind(tool) as (
      toolContext: unknown,
    ) => AsyncGenerator<unknown, unknown, unknown>;
    const call = new AsyncLocalStorage<InFlight>();
    // Runs once Thoth allows the call: hands back the checked input, then
    // stays open until the tool finishes, so completion is recorded then.
    const governed = session.wrap(tool.name, (checked: unknown) => {
      const current = call.getStore();
      if (!current) throw new Error("governed tool called outside a run");
      return new Promise((done, failed) => {
        current.finish = done;
        current.fail = failed;
        current.allowed(checked);
      });
    });

    async function* governedStream(
      toolContext: ToolContextLike,
    ): AsyncGenerator<unknown, unknown, unknown> {
      const input = toolContext.toolUse.input ?? {};
      let allow!: (checked: unknown) => void;
      const allowed = new Promise<unknown>((resolve) => {
        allow = resolve;
      });
      const inFlight: InFlight = { allowed: allow };
      const outcome = call.run(inFlight, () =>
        Promise.resolve(governed(input)),
      );
      outcome.catch(() => undefined);
      const verdict = await Promise.race([
        allowed.then((checked) => ({ ok: true as const, checked })),
        outcome.then(
          () => ({ ok: false as const, error: new Error("tool not run") }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      if (!verdict.ok) throw verdict.error;
      // Exactly the input Thoth checked.
      const checkedContext = {
        ...toolContext,
        toolUse: { ...toolContext.toolUse, input: verdict.checked },
      };
      let settled = false;
      try {
        const result = yield* stream(checkedContext);
        settled = true;
        inFlight.finish?.(result);
        return result;
      } catch (error) {
        settled = true;
        inFlight.fail?.(error);
        throw error;
      } finally {
        // The consumer stopped reading early: the call ends without a result.
        if (!settled) inFlight.fail?.(new Error("tool stream closed early"));
      }
    }

    return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      stream: governedStream,
    }) as T;
  });
}
