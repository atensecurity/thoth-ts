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
import { type ThothConfig } from "../models.js";
/** Genkit's tool request part: `{ toolRequest: { name, ref, input } }`. */
export interface GenkitToolRequestPart {
    toolRequest: {
        name: string;
        ref?: string;
        input?: unknown;
    };
}
/**
 * The shape of Genkit's `generateMiddleware`. Its callback returns Genkit's
 * own `GenerateMiddlewareDef` type, which this SDK doesn't import, hence `any`.
 */
export type GenerateMiddlewareFactory<M> = (options: {
    name: string;
    description?: string;
}, middlewareFn: () => any) => M;
/**
 * Returns Genkit generate middleware that governs every tool call in one
 * Thoth session. Build it per session (for example per request, with that
 * request's `userId`) and pass it last in `use`.
 */
export declare function thothGenkitMiddleware<M>(generateMiddleware: GenerateMiddlewareFactory<M>, config: ThothConfig): M;
//# sourceMappingURL=genkit.d.ts.map