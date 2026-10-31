/**
 * Google Agent Development Kit (ADK) integration for @atensec/thoth.
 *
 * Governs an ADK agent's tools (`FunctionTool`, MCP tools, agent tools): each
 * call is checked by Thoth when the tool runs, with its final arguments, and
 * the tool runs with exactly the arguments Thoth checked. ADK runs every tool
 * through `runAsync({ args, toolContext })`; the tool context reaches the tool
 * unchanged.
 *
 * Checking at the tool, rather than in a `beforeToolCallback`, means another
 * callback can't change the arguments after the check.
 *
 * @example
 * ```typescript
 * import { LlmAgent } from "@google/adk";
 * import { governAdkTools } from "@atensec/thoth/google-adk";
 *
 * const agent = new LlmAgent({
 *   name: "trader",
 *   model: "gemini-2.5-flash",
 *   tools: governAdkTools([listOrders, wireFunds], {
 *     agentId: "trader",
 *     tenantId: process.env.THOTH_TENANT_ID!,
 *     approvedScope: [],
 *     userId,
 *   }),
 * });
 * ```
 *
 * A refused call never runs: `runAsync` throws ThothPolicyViolation.
 */

import type { ThothConfig } from "../models.js";
import { governExecutes } from "./govern.js";

/** The parts of an ADK tool this integration uses. */
export interface AdkToolLike {
  name: string;
  description?: string;
  runAsync(request: {
    args: Record<string, unknown>;
    toolContext: never;
  }): Promise<unknown>;
  _getDeclaration?():
    | { parameters?: unknown; parametersJsonSchema?: unknown }
    | undefined;
}

function declaredSchema(tool: AdkToolLike): unknown {
  try {
    const declaration = tool._getDeclaration?.();
    return declaration?.parametersJsonSchema ?? declaration?.parameters;
  } catch {
    // Advisory metadata must never affect governance.
    return undefined;
  }
}

/**
 * Returns governed copies of `tools`, in the same order, in one Thoth
 * session. The copies keep each tool's fields and class; the tools passed in
 * are unchanged, so govern them per agent or request.
 */
export function governAdkTools<T extends AdkToolLike>(
  tools: readonly T[],
  config: ThothConfig,
): T[] {
  const governed = governExecutes(
    tools.map((tool) => {
      const runAsync = tool.runAsync.bind(tool) as (request: {
        args: unknown;
        toolContext: unknown;
      }) => Promise<unknown>;
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: declaredSchema(tool),
        // Runs with exactly the arguments Thoth checked.
        execute: (args: unknown, toolContext?: unknown) =>
          runAsync({ args, toolContext }),
      };
    }),
    config,
  );
  return tools.map((tool) => {
    const run = governed.get(tool.name) as (
      args: unknown,
      toolContext: unknown,
    ) => Promise<unknown>;
    return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      runAsync: (request: {
        args: Record<string, unknown>;
        toolContext: unknown;
      }) => run(request.args ?? {}, request.toolContext),
    }) as T;
  });
}
