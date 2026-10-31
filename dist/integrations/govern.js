/**
 * The shared core of the framework integrations: governs a set of tool
 * `execute` functions with one Thoth session.
 *
 * Frameworks call a tool as `execute(input, ...extra)`, where `extra` is the
 * framework's own call details (a tool call ID, an abort signal, a run
 * context). Only `input` is sent to Thoth as the tool's arguments; `extra`
 * reaches the original function untouched, and is never serialized.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { instrument } from "../instrumentor.js";
/** The tool's input schema as JSON Schema for the tool inventory, or {}. */
export function jsonSchemaOf(schema) {
    try {
        if (!schema || typeof schema !== "object")
            return {};
        const wrapped = schema.jsonSchema;
        if (wrapped && typeof wrapped === "object" && !("then" in wrapped)) {
            return wrapped;
        }
        if ("_zod" in schema) {
            return z.toJSONSchema(schema, {
                unrepresentable: "any",
            });
        }
        if ("type" in schema || "properties" in schema) {
            return schema;
        }
    }
    catch {
        /* Advisory metadata must never affect governance. */
    }
    return {};
}
/**
 * Returns a governed `execute` per tool name. Each call is checked by Thoth
 * before the original runs; a refusal throws ThothPolicyViolation and the
 * original never runs.
 */
export function governExecutes(tools, config) {
    const extraArgs = new AsyncLocalStorage();
    const agent = {
        tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: jsonSchemaOf(tool.inputSchema),
            run: (input) => tool.execute(input, ...(extraArgs.getStore() ?? [])),
        })),
    };
    instrument(agent, config);
    const governed = new Map();
    for (const tool of agent.tools) {
        const run = tool.run;
        governed.set(tool.name, (input, ...extra) => extraArgs.run(extra, () => run(input)));
    }
    return governed;
}
//# sourceMappingURL=govern.js.map