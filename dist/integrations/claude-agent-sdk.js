/**
 * Claude Agent SDK integration for @atensec/thoth.
 *
 * Adds Thoth to `query()` options as hooks, so every tool call the agent makes
 * (built-in tools, MCP tools and your own) is checked before it runs. A
 * PreToolUse hook is used, not `canUseTool`: the SDK skips `canUseTool` for
 * tools already allowed (`allowedTools`, or bypass-permissions mode), while
 * PreToolUse runs before every tool call.
 *
 * @example
 * ```typescript
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { governClaudeAgentOptions } from "@atensec/thoth/claude-agent-sdk";
 *
 * for await (const message of query({
 *   prompt: "Summarise today's open orders",
 *   options: governClaudeAgentOptions(
 *     { allowedTools: ["mcp__orders__list_orders"] },
 *     { agentId: "trader", tenantId: process.env.THOTH_TENANT_ID!, approvedScope: [], userId },
 *   ),
 * })) { ... }
 * ```
 *
 * - Thoth allows: the hook returns no decision, so the SDK's own permission
 *   rules still apply. Thoth never grants what they would refuse.
 * - Thoth refuses (or the check fails): the hook denies the call with
 *   Thoth's reason, which the model sees; the tool never runs.
 * - Thoth would change the arguments: the call is denied, because the SDK
 *   doesn't document passing changed input without overriding its own
 *   permission rules.
 * - A held call waits for a reviewer, up to the hook timeout (16 minutes).
 *
 * The call's completion is recorded when the tool finishes (PostToolUse).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { openSession } from "../instrumentor.js";
import { ThothPolicyViolation } from "../models.js";
// Longer than the default step-up wait, so a held call can be decided.
const HOOK_TIMEOUT_SECONDS = 16 * 60;
// A call the SDK never finishes (refused by its own rules after this hook, or
// interrupted) stops being tracked after this long.
const FINISH_WAIT_MS = 30 * 60 * 1000;
function same(a, b) {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
function deny(reason) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
        },
    };
}
/**
 * Returns a copy of `options` with Thoth's PreToolUse, PostToolUse and
 * PostToolUseFailure hooks added after any you already set. One Thoth session
 * per call: govern the options for each `query()`, with that run's `userId`.
 */
export function governClaudeAgentOptions(options, config) {
    const session = openSession(config);
    const call = new AsyncLocalStorage();
    const finishing = new Map();
    const governed = new Map();
    const governedFor = (name) => {
        let run = governed.get(name);
        if (!run) {
            // Runs only once Thoth allows the call: report it, then stay open until
            // the tool finishes, so completion is recorded when it really happens.
            run = session.wrap(name, (checked) => {
                const current = call.getStore();
                if (!current)
                    return undefined;
                current.allowed(checked);
                return new Promise((done, failed) => {
                    const timer = setTimeout(() => {
                        finishing.delete(current.id);
                        failed(new Error("tool call never finished"));
                    }, FINISH_WAIT_MS);
                    timer.unref?.();
                    finishing.set(current.id, { done, failed, timer });
                });
            });
            governed.set(name, run);
        }
        return run;
    };
    const preToolUse = async (input, toolUseID) => {
        if (input.hook_event_name !== "PreToolUse")
            return {};
        const name = input.tool_name;
        if (typeof name !== "string" || !name) {
            return deny("Thoth couldn't identify this tool call.");
        }
        const toolInput = input.tool_input && typeof input.tool_input === "object"
            ? input.tool_input
            : {};
        const id = (typeof input.tool_use_id === "string" && input.tool_use_id) ||
            toolUseID ||
            crypto.randomUUID();
        let allow;
        const allowed = new Promise((resolve) => {
            allow = resolve;
        });
        const outcome = call.run({ id, allowed: allow }, () => Promise.resolve(governedFor(name)(toolInput)));
        // Recorded by the wrapper; nothing more to do once the tool has finished.
        outcome.catch(() => undefined);
        const verdict = await Promise.race([
            allowed.then((checked) => ({ ok: true, checked })),
            outcome.then(() => ({ ok: false, error: undefined }), (error) => ({ ok: false, error })),
        ]);
        if (!verdict.ok) {
            return deny(verdict.error instanceof ThothPolicyViolation
                ? `Thoth refused this call: ${verdict.error.reason}`
                : "Thoth couldn't check this call, so it was not run.");
        }
        if (!same(verdict.checked, toolInput)) {
            finishing.get(id)?.failed(new Error("not run: arguments changed"));
            return deny("Thoth would change this call's arguments, which this integration doesn't apply, so it was not run.");
        }
        return {};
    };
    const finish = (succeeded) => async (input, toolUseID) => {
        const id = (typeof input.tool_use_id === "string" && input.tool_use_id) ||
            toolUseID;
        const pending = id ? finishing.get(id) : undefined;
        if (id && pending) {
            finishing.delete(id);
            clearTimeout(pending.timer);
            if (succeeded)
                pending.done(input.tool_response);
            else
                pending.failed(new Error(String(input.error ?? "tool failed")));
        }
        return {};
    };
    const hooks = {
        ...(options.hooks ?? {}),
    };
    const add = (event, hook, timeout) => {
        hooks[event] = [
            ...(hooks[event] ?? []),
            { hooks: [hook], ...(timeout ? { timeout } : {}) },
        ];
    };
    add("PreToolUse", preToolUse, HOOK_TIMEOUT_SECONDS);
    add("PostToolUse", finish(true));
    add("PostToolUseFailure", finish(false));
    return { ...options, hooks };
}
//# sourceMappingURL=claude-agent-sdk.js.map