/**
 * OpenAI integration for @atensec/thoth.
 *
 * Wraps tool execution functions with Thoth governance for use in an OpenAI
 * function-calling / tool-calling loop. OpenAI returns `tool_calls` on the
 * assistant message; you execute them and send back `tool` role messages.
 * Thoth intercepts at the execution level.
 *
 * @example
 * ```typescript
 * import OpenAI from "openai";
 * import { wrapOpenAITools } from "@atensec/thoth/openai";
 *
 * const client = new OpenAI();
 *
 * const tools: OpenAI.ChatCompletionTool[] = [
 *   {
 *     type: "function",
 *     function: {
 *       name: "search_docs",
 *       description: "Search internal documentation",
 *       parameters: {
 *         type: "object",
 *         properties: { query: { type: "string" } },
 *         required: ["query"],
 *       },
 *     },
 *   },
 * ];
 *
 * const wrappedFns = wrapOpenAITools(
 *   { search_docs: mySearchFn },
 *   { agentId: "support-bot-v2", approvedScope: ["search_docs"], tenantId: "acme-corp" },
 * );
 *
 * // Standard OpenAI agentic loop
 * const messages: OpenAI.ChatCompletionMessageParam[] = [
 *   { role: "user", content: "Find docs about access control" },
 * ];
 * while (true) {
 *   const response = await client.chat.completions.create({ model: "gpt-5", tools, messages });
 *   const msg = response.choices[0].message;
 *   if (!msg.tool_calls?.length) break;
 *   messages.push(msg);
 *   for (const call of msg.tool_calls) {
 *     const fn = wrappedFns[call.function.name];
 *     if (fn) {
 *       const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
 *       const result = await fn(args); // governance runs here
 *       messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
 *     }
 *   }
 * }
 * ```
 */
import type { ThothConfig } from "../models";
/** A tool function that receives OpenAI parsed function arguments. */
export type OpenAIToolFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;
/**
 * Wrap a dict of tool functions for use in an OpenAI tool-calling loop.
 *
 * Each function in `toolFns` is wrapped with Thoth policy enforcement and
 * behavioral event emission. The returned dict has the same keys but governed
 * callables — drop it into your agentic loop in place of the raw functions.
 *
 * @param toolFns - Map of tool name → function (receives parsed JSON args).
 * @param config  - Thoth configuration (agentId, tenantId, approvedScope, …).
 * @returns New map with the same keys but governance-wrapped functions.
 */
export declare function wrapOpenAITools(toolFns: Record<string, OpenAIToolFn>, config: ThothConfig): Record<string, OpenAIToolFn>;
//# sourceMappingURL=openai.d.ts.map