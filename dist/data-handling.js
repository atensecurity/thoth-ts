// Drop, redact or hash values at the source, before a request leaves the process.
//
// Opt-in per client. With nothing configured this module changes nothing.
//
// Tool arguments (THOTH_DATA_HANDLING_TOOL_ARGUMENTS or `dataHandlingToolArguments`):
//   hash    keys and structure kept; every leaf except null becomes
//           "hmac-sha256:" + hex(HMAC-SHA256(salt, canonicalJson(leaf))).
//   redact  keys and structure kept; every leaf, null included, becomes "<redacted>".
//   drop    no arguments are sent: the `tool_args` field is omitted.
// Prompts (THOTH_DATA_HANDLING_PROMPTS or `dataHandlingPrompts`):
//   hash    a prompt-bearing field becomes one hash of its whole value.
//   drop    the field is omitted.
//
// The salt is held by the client and never sent: `dataHandlingSalt`, else
// THOTH_DATA_HANDLING_SALT, else a random per-process salt.
//
// Nested arguments are walked to depth 16 and at most 5,000 values. Anything
// deeper is replaced by "<truncated>"; once the budget is spent an object gains
// the key "_truncated" and an array ends with "<truncated>". The output never
// contains an original value that was not transformed.
//
// The golden fixture testdata/sdk/data_handling_golden.json pins these formats
// so every Thoth SDK produces the same bytes.
import { createHmac, randomBytes } from "node:crypto";
export const TOOL_ARGUMENT_MODES = ["hash", "redact", "drop"];
export const PROMPT_MODES = ["hash", "drop"];
export const DATA_HANDLING_VERSION = 1;
export const REDACTED = "<redacted>";
export const TRUNCATED = "<truncated>";
export const HASH_PREFIX = "hmac-sha256:";
export const MAX_DEPTH = 16;
export const MAX_NODES = 5000;
// Strings longer than this inside a context object count as free text.
export const LONG_TEXT_CHARS = 512;
export const ENV_TOOL_ARGUMENTS = "THOTH_DATA_HANDLING_TOOL_ARGUMENTS";
export const ENV_PROMPTS = "THOTH_DATA_HANDLING_PROMPTS";
export const ENV_SALT = "THOTH_DATA_HANDLING_SALT";
export const ENV_LOCAL_SCAN = "THOTH_DATA_HANDLING_LOCAL_SCAN";
// Values under these key names, at any depth of a context object, are model or
// user text: the prompts mode applies. Spelling-insensitive.
export const PROMPT_KEYS = new Set([
    "prompt",
    "prompts",
    "systemprompt",
    "userprompt",
    "usermessage",
    "message",
    "messages",
    "input",
    "inputtext",
    "query",
    "question",
    "text",
    "content",
    "instruction",
    "instructions",
    "task",
    "goal",
    "description",
    "summary",
    "note",
    "notes",
    "comment",
    "conversation",
    "conversationcontext",
    "conversationinputtext",
    "conversationoutputtext",
    "history",
    "transcript",
    "completion",
    "response",
    "output",
    "toolresult",
    "tooloutput",
]);
function env(name) {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
}
let processSalt;
/** The random salt shared by every client in this process, made once. */
export function getProcessSalt() {
    processSalt ?? (processSalt = randomBytes(32).toString("hex"));
    return processSalt;
}
function blank(value) {
    return (value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === ""));
}
function normalizeMode(value, allowed, name) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string") {
        throw new Error(`${name} must be one of ${allowed.join(", ")}`);
    }
    const mode = value.trim().toLowerCase();
    if (!mode)
        return undefined;
    if (!allowed.includes(mode)) {
        throw new Error(`${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}. ` +
            "Thoth will not send the values unprotected, so fix the setting.");
    }
    return mode;
}
export function resolveToolArgumentsMode(value) {
    return blank(value)
        ? normalizeMode(env(ENV_TOOL_ARGUMENTS), TOOL_ARGUMENT_MODES, ENV_TOOL_ARGUMENTS)
        : normalizeMode(value, TOOL_ARGUMENT_MODES, "dataHandlingToolArguments");
}
export function resolvePromptsMode(value) {
    return blank(value)
        ? normalizeMode(env(ENV_PROMPTS), PROMPT_MODES, ENV_PROMPTS)
        : normalizeMode(value, PROMPT_MODES, "dataHandlingPrompts");
}
/** The configured salt (option, else environment); undefined means use the per-process salt. */
export function resolveSalt(value) {
    const chosen = blank(value) ? env(ENV_SALT) : value;
    if (chosen === undefined || chosen === null)
        return undefined;
    if (typeof chosen !== "string")
        throw new Error("dataHandlingSalt must be a string");
    return chosen.trim() ? chosen : undefined;
}
/** Whether to scan withheld arguments locally: option, else environment, default true. Throws on an unclear value. */
export function resolveLocalScan(value) {
    const chosen = blank(value) ? env(ENV_LOCAL_SCAN) : value;
    if (chosen === undefined ||
        chosen === null ||
        (typeof chosen === "string" && !chosen.trim())) {
        return true;
    }
    if (typeof chosen === "boolean")
        return chosen;
    if (typeof chosen === "string") {
        const word = chosen.trim().toLowerCase();
        if (["on", "true", "1", "yes"].includes(word))
            return true;
        if (["off", "false", "0", "no"].includes(word))
            return false;
    }
    throw new Error("dataHandlingLocalScan must be on or off");
}
// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------
// Sorted by Unicode code point, as the other SDKs do (default Array sort compares UTF-16 units).
function compareCodePoints(a, b) {
    const x = Array.from(a);
    const y = Array.from(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i += 1) {
        const diff = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (diff !== 0)
            return diff;
    }
    return x.length - y.length;
}
/** Keys sorted by code point, no spaces, non-ASCII not escaped. */
export function canonicalJson(value) {
    if (value === null || value === undefined)
        return "null";
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const record = value;
        const keys = Object.keys(record).sort(compareCodePoints);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    if (typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number")
        return Number.isFinite(value)
            ? JSON.stringify(value)
            : JSON.stringify(String(value));
    return JSON.stringify(String(value));
}
export function hashValue(salt, value) {
    const digest = createHmac("sha256", Buffer.from(salt, "utf8"))
        .update(Buffer.from(canonicalJson(value), "utf8"))
        .digest("hex");
    return HASH_PREFIX + digest;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mapLeaves(value, leaf, budget, depth) {
    if (budget.remaining <= 0 || depth > MAX_DEPTH)
        return TRUNCATED;
    budget.remaining -= 1;
    if (isRecord(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (budget.remaining <= 0) {
                out["_truncated"] = TRUNCATED;
                break;
            }
            defineOwn(out, key, mapLeaves(item, leaf, budget, depth + 1));
        }
        return out;
    }
    if (Array.isArray(value)) {
        const items = [];
        for (const item of value) {
            if (budget.remaining <= 0) {
                items.push(TRUNCATED);
                break;
            }
            items.push(mapLeaves(item, leaf, budget, depth + 1));
        }
        return items;
    }
    return leaf(value);
}
// A key named __proto__ must stay an own property of the copy.
function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
export function redactArguments(value) {
    return mapLeaves(value, () => REDACTED, { remaining: MAX_NODES }, 0);
}
export function hashArguments(value, salt) {
    return mapLeaves(value, (leaf) => leaf === null || leaf === undefined ? leaf : hashValue(salt, leaf), { remaining: MAX_NODES }, 0);
}
/** `[keep, newValue]` for tool arguments under `mode`. */
export function transformArguments(value, mode, salt) {
    if (mode === "drop")
        return [false, undefined];
    if (mode === "redact")
        return [true, redactArguments(value)];
    if (mode === "hash")
        return [true, hashArguments(value, salt)];
    throw new Error(`unknown tool arguments mode ${String(mode)}`);
}
/** `[keep, newValue]` for a prompt-bearing value under `mode`. */
export function transformPrompt(value, mode, salt) {
    if (mode === "drop")
        return [false, undefined];
    if (mode === "hash")
        return [
            true,
            value === null || value === undefined ? null : hashValue(salt, value),
        ];
    throw new Error(`unknown prompts mode ${String(mode)}`);
}
function normalizedKey(key) {
    return key.toLowerCase().replace(/[_-]/g, "");
}
function walkContext(node, mode, salt, depth = 0) {
    if (depth > MAX_DEPTH)
        return TRUNCATED;
    if (isRecord(node)) {
        const out = {};
        for (const [key, item] of Object.entries(node)) {
            if (PROMPT_KEYS.has(normalizedKey(key))) {
                const [keep, next] = transformPrompt(item, mode, salt);
                if (keep)
                    defineOwn(out, key, next);
                continue;
            }
            defineOwn(out, key, walkContext(item, mode, salt, depth + 1));
        }
        return out;
    }
    if (Array.isArray(node))
        return node.map((item) => walkContext(item, mode, salt, depth + 1));
    if (typeof node === "string" && Array.from(node).length > LONG_TEXT_CHARS) {
        // Free text under an unremarkable key. It cannot be omitted from a list or a
        // value position without changing structure, so it is hashed or redacted.
        return mode === "hash" ? hashValue(salt, node) : REDACTED;
    }
    return node;
}
export function transformContext(value, mode, salt) {
    return walkContext(value, mode, salt);
}
const CONTEXT_FIELDS = [
    "task_context",
    "auth_context",
    "delegation_context",
    "identity_binding",
    "metadata",
];
/** What this client applies before sending. Immutable. */
export class DataHandling {
    constructor(toolArguments, prompts, salt) {
        this.toolArguments = toolArguments;
        this.prompts = prompts;
        this.salt = salt;
    }
    /** Options, else environment. Undefined when nothing is configured. Throws on an invalid value. */
    static resolve(options = {}) {
        const toolArguments = resolveToolArgumentsMode(options.dataHandlingToolArguments);
        const prompts = resolvePromptsMode(options.dataHandlingPrompts);
        if (toolArguments === undefined && prompts === undefined)
            return undefined;
        return new DataHandling(toolArguments, prompts, resolveSalt(options.dataHandlingSalt) ?? getProcessSalt());
    }
    /** The `data_handling` field of the request, naming only what was applied. */
    declaration() {
        return {
            ...(this.toolArguments !== undefined && {
                tool_arguments: this.toolArguments,
            }),
            ...(this.prompts !== undefined && { prompts: this.prompts }),
            applied_at: "client",
            version: DATA_HANDLING_VERSION,
        };
    }
    /** Transforms the value-carrying fields of an enforce or explain payload, in place, and declares it. */
    apply(payload) {
        if (this.toolArguments !== undefined && "tool_args" in payload) {
            const [keep, next] = transformArguments(payload["tool_args"], this.toolArguments, this.salt);
            if (keep)
                payload["tool_args"] = next;
            else
                delete payload["tool_args"];
        }
        if (this.prompts !== undefined) {
            for (const name of CONTEXT_FIELDS) {
                const field = payload[name];
                if (field !== undefined &&
                    field !== null &&
                    !(isRecord(field) && Object.keys(field).length === 0)) {
                    payload[name] = transformContext(field, this.prompts, this.salt);
                }
            }
        }
        payload["data_handling"] = this.declaration();
        return payload;
    }
}
const resolved = new WeakMap();
/**
 * The data handling a config asks for, resolved once per config object (so an
 * invalid value fails when the client is built, and every call shares one salt).
 */
export function dataHandlingFor(config) {
    if (resolved.has(config))
        return resolved.get(config);
    const handling = DataHandling.resolve(config);
    resolved.set(config, handling);
    return handling;
}
/** True when tool-argument values are not sent to Thoth (hash, redact or drop). */
export function argumentsWithheld(config) {
    return dataHandlingFor(config)?.toolArguments !== undefined;
}
const scanResolved = new WeakMap();
/** Whether the local scan is on for this config (default true; only used when arguments are withheld). */
export function localScanEnabled(config) {
    const cached = scanResolved.get(config);
    if (cached !== undefined)
        return cached;
    const on = resolveLocalScan(config.dataHandlingLocalScan);
    scanResolved.set(config, on);
    return on;
}
//# sourceMappingURL=data-handling.js.map