/**
 * Anthropic Claude integration for @atensec/thoth.
 *
 * Wraps tool execution functions with Thoth governance for use in an Anthropic
 * agentic loop. The Anthropic SDK returns `tool_use` content blocks; you call
 * the tools yourself. Thoth intercepts at the execution level.
 *
 * @example
 * ```typescript
 * import Anthropic from "@anthropic-ai/sdk";
 * import { wrapAnthropicTools } from "@atensec/thoth/anthropic";
 *
 * const client = new Anthropic();
 *
 * const tools: Anthropic.Tool[] = [
 *   {
 *     name: "search_docs",
 *     description: "Search internal documentation",
 *     input_schema: {
 *       type: "object",
 *       properties: { query: { type: "string" } },
 *       required: ["query"],
 *     },
 *   },
 * ];
 *
 * const wrappedFns = wrapAnthropicTools(
 *   { search_docs: mySearchFn },
 *   { agentId: "support-bot-v2", approvedScope: ["search_docs"], tenantId: "acme-corp" },
 * );
 *
 * // Standard Anthropic agentic loop
 * const messages: Anthropic.MessageParam[] = [
 *   { role: "user", content: "Find docs about access control" },
 * ];
 * while (true) {
 *   const response = await client.messages.create({
 *     model: "claude-opus-4-6",
 *     max_tokens: 1024,
 *     tools,
 *     messages,
 *   });
 *   if (response.stop_reason === "end_turn") break;
 *   const toolResults: Anthropic.ToolResultBlockParam[] = [];
 *   for (const block of response.content) {
 *     if (block.type === "tool_use") {
 *       const fn = wrappedFns[block.name];
 *       if (fn) {
 *         const result = await fn(block.input); // governance runs here
 *         toolResults.push({ type: "tool_result", tool_use_id: block.id, content: String(result) });
 *       }
 *     }
 *   }
 *   messages.push({ role: "assistant", content: response.content });
 *   messages.push({ role: "user", content: toolResults });
 * }
 * ```
 */
import { instrument } from "../instrumentor";
/**
 * Wrap a dict of tool functions for use in an Anthropic Claude agentic loop.
 *
 * Each function in `toolFns` is wrapped with Thoth policy enforcement and
 * behavioral event emission. The returned dict has the same keys but governed
 * callables — drop it into your agentic loop in place of the raw functions.
 *
 * @param toolFns - Map of tool name → function (receives `block.input`).
 * @param config  - Thoth configuration (agentId, tenantId, approvedScope, …).
 * @returns New map with the same keys but governance-wrapped functions.
 */
export function wrapAnthropicTools(toolFns, config) {
    // Build a synthetic "agent" object matching the shape instrument() expects,
    // then extract the wrapped versions from it.
    const syntheticAgent = {
        tools: Object.entries(toolFns).map(([name, fn]) => ({
            name,
            run: fn,
        })),
    };
    instrument(syntheticAgent, config);
    const wrapped = {};
    for (const tool of syntheticAgent.tools) {
        wrapped[tool.name] = tool.run;
    }
    return wrapped;
}
//# sourceMappingURL=anthropic.js.map