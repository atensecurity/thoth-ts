/**
 * Genkit integration for @atensec/thoth.
 *
 * Builds Genkit generate middleware whose `tool` hook checks every tool call
 * with Thoth before it runs, and runs the tool with exactly the input Thoth
 * checked. Pass it last in `use`, so it is the innermost middleware: its
 * `next` is then the tool itself, and no other middleware can change the
 * input after the check.
 *
 * Genkit isn't a dependency of this SDK, so pass Genkit's own
 * `generateMiddleware` in.
 *
 * @example
 * ```typescript
 * import { generateMiddleware, genkit } from "genkit";
 * import { thothGenkitMiddleware } from "@atensec/thoth/genkit";
 *
 * const thoth = thothGenkitMiddleware(generateMiddleware, {
 *   agentId: "trader",
 *   tenantId: process.env.THOTH_TENANT_ID!,
 *   approvedScope: [],
 *   userId,
 * });
 * await ai.generate({ prompt, tools: [listOrders, wireFunds], use: [thoth()] });
 * ```
 *
 * A refused call never runs: the model gets "Thoth refused this call:
 * <reason>" as the tool's output, and Thoth records the refusal.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { openSession } from "../instrumentor.js";
import { ThothPolicyViolation } from "../models.js";
/**
 * Returns Genkit generate middleware that governs every tool call in one
 * Thoth session. Build it per session (for example per request, with that
 * request's `userId`) and pass it last in `use`.
 */
export function thothGenkitMiddleware(generateMiddleware, config) {
    const session = openSession(config);
    const call = new AsyncLocalStorage();
    const governed = new Map();
    const governedFor = (name) => {
        let run = governed.get(name);
        if (!run) {
            session.report([{ name }]);
            run = session.wrap(name, (checked) => {
                const current = call.getStore();
                if (!current)
                    throw new Error("governed tool called outside generate");
                // Exactly the input Thoth checked.
                return current.next({
                    ...current.req,
                    toolRequest: { ...current.req.toolRequest, input: checked },
                }, current.ctx);
            });
            governed.set(name, run);
        }
        return run;
    };
    return generateMiddleware({
        name: "thoth",
        description: "Checks every tool call with Thoth before it runs.",
    }, () => ({
        tool: async (req, ctx, next) => {
            const { name, ref, input } = req.toolRequest;
            try {
                return await call.run({ req, ctx, next }, () => Promise.resolve(governedFor(name)(input ?? {})));
            }
            catch (error) {
                if (!(error instanceof ThothPolicyViolation))
                    throw error;
                // The tool did not run; the model is told, and Thoth recorded it.
                return {
                    toolResponse: {
                        name,
                        ...(ref !== undefined ? { ref } : {}),
                        output: `Thoth refused this call: ${error.reason}`,
                    },
                };
            }
        },
    }));
}
//# sourceMappingURL=genkit.js.map