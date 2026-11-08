export declare const TOOL_ARGUMENT_MODES: readonly ["hash", "redact", "drop"];
export declare const PROMPT_MODES: readonly ["hash", "drop"];
export type ToolArgumentsMode = (typeof TOOL_ARGUMENT_MODES)[number];
export type PromptsMode = (typeof PROMPT_MODES)[number];
export declare const DATA_HANDLING_VERSION = 1;
export declare const REDACTED = "<redacted>";
export declare const TRUNCATED = "<truncated>";
export declare const HASH_PREFIX = "hmac-sha256:";
export declare const MAX_DEPTH = 16;
export declare const MAX_NODES = 5000;
export declare const LONG_TEXT_CHARS = 512;
export declare const ENV_TOOL_ARGUMENTS = "THOTH_DATA_HANDLING_TOOL_ARGUMENTS";
export declare const ENV_PROMPTS = "THOTH_DATA_HANDLING_PROMPTS";
export declare const ENV_SALT = "THOTH_DATA_HANDLING_SALT";
export declare const ENV_LOCAL_SCAN = "THOTH_DATA_HANDLING_LOCAL_SCAN";
export declare const PROMPT_KEYS: ReadonlySet<string>;
/** The options that configure data handling (also read from the environment). */
export interface DataHandlingOptions {
    dataHandlingToolArguments?: string;
    dataHandlingPrompts?: string;
    dataHandlingSalt?: string;
    dataHandlingLocalScan?: boolean | string;
}
/** The random salt shared by every client in this process, made once. */
export declare function getProcessSalt(): string;
export declare function resolveToolArgumentsMode(value: unknown): ToolArgumentsMode | undefined;
export declare function resolvePromptsMode(value: unknown): PromptsMode | undefined;
/** The configured salt (option, else environment); undefined means use the per-process salt. */
export declare function resolveSalt(value: unknown): string | undefined;
/** Whether to scan withheld arguments locally: option, else environment, default true. Throws on an unclear value. */
export declare function resolveLocalScan(value: unknown): boolean;
/** Keys sorted by code point, no spaces, non-ASCII not escaped. */
export declare function canonicalJson(value: unknown): string;
export declare function hashValue(salt: string, value: unknown): string;
export declare function redactArguments(value: unknown): unknown;
export declare function hashArguments(value: unknown, salt: string): unknown;
/** `[keep, newValue]` for tool arguments under `mode`. */
export declare function transformArguments(value: unknown, mode: ToolArgumentsMode, salt: string): [boolean, unknown];
/** `[keep, newValue]` for a prompt-bearing value under `mode`. */
export declare function transformPrompt(value: unknown, mode: PromptsMode, salt: string): [boolean, unknown];
export declare function transformContext(value: unknown, mode: PromptsMode, salt: string): unknown;
/** What this client applies before sending. Immutable. */
export declare class DataHandling {
    readonly toolArguments: ToolArgumentsMode | undefined;
    readonly prompts: PromptsMode | undefined;
    readonly salt: string;
    constructor(toolArguments: ToolArgumentsMode | undefined, prompts: PromptsMode | undefined, salt: string);
    /** Options, else environment. Undefined when nothing is configured. Throws on an invalid value. */
    static resolve(options?: DataHandlingOptions): DataHandling | undefined;
    /** The `data_handling` field of the request, naming only what was applied. */
    declaration(): Record<string, unknown>;
    /** Transforms the value-carrying fields of an enforce or explain payload, in place, and declares it. */
    apply(payload: Record<string, unknown>): Record<string, unknown>;
}
/**
 * The data handling a config asks for, resolved once per config object (so an
 * invalid value fails when the client is built, and every call shares one salt).
 */
export declare function dataHandlingFor(config: DataHandlingOptions): DataHandling | undefined;
/** True when tool-argument values are not sent to Thoth (hash, redact or drop). */
export declare function argumentsWithheld(config: DataHandlingOptions): boolean;
/** Whether the local scan is on for this config (default true; only used when arguments are withheld). */
export declare function localScanEnabled(config: DataHandlingOptions): boolean;
//# sourceMappingURL=data-handling.d.ts.map