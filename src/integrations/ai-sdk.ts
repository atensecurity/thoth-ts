/**
 * Vercel AI SDK integration for @atensec/thoth.
 *
 * Governs a tool set for `generateText`, `streamText` or an `Agent`: every
 * tool with an `execute` is checked by Thoth before it runs. Tools without
 * `execute` (provider-executed or client-side tools) are left as they are.
 *
 * @example
 * ```typescript
 * import { generateText, tool } from "ai";
 * import { z } from "zod";
 * import { governAiSdkTools } from "@atensec/thoth/ai-sdk";
 *
 * const tools = governAiSdkTools(
 *   {
 *     listOrders: tool({
 *       description: "List open orders for an account",
 *       inputSchema: z.object({ account: z.string() }),
 *       execute: async ({ account }) => orders.list(account),
 *     }),
 *   },
 *   { agentId: "trader", tenantId: "acme", approvedScope: ["listOrders"], userId },
 * );
 *
 * await generateText({ model, tools, prompt: "What's open on A-1?" });
 * ```
 *
 * A refused call throws ThothPolicyViolation from `execute`; the AI SDK
 * reports it as the tool's error and the original never runs.
 */

import type { ThothConfig } from "../models.js";
import { governExecutes } from "./govern.js";

/** The parts of an AI SDK tool this integration reads. */
export interface AiSdkTool {
  /** A string, or (since AI SDK 7) a function of the call's context. */
  description?: unknown;
  inputSchema?: unknown;
  execute?: (input: never, options: never) => unknown;
}

/**
 * Returns a copy of `tools` whose `execute` functions are governed by Thoth,
 * keyed by the same tool names. Call it once per session (for example per
 * request, with that request's `userId`); the tools passed in are unchanged.
 */
export function governAiSdkTools<T extends Record<string, object>>(
  tools: T,
  config: ThothConfig,
): T {
  const executable = Object.entries(tools as Record<string, AiSdkTool>).filter(
    ([, tool]) => typeof tool.execute === "function",
  );
  const governed = governExecutes(
    executable.map(([name, tool]) => ({
      name,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.inputSchema,
      execute: tool.execute as (input: unknown, ...extra: unknown[]) => unknown,
    })),
    config,
  );
  const out: Record<string, object> = { ...tools };
  for (const [name, tool] of executable) {
    out[name] = { ...tool, execute: governed.get(name) };
  }
  return out as T;
}
