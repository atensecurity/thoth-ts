import spec from "./detectors.v1.json";
export declare const SCANNER_NAME = "atensec-thoth-ts";
export declare const REPORT_VERSION = 1;
/** The detector spec could not be loaded or does not match its pinned hash. */
export declare class LocalScanError extends Error {
}
export interface Finding {
    kind: string;
    [key: string]: unknown;
}
export interface ScanResult {
    scanned: string[];
    findings: Finding[];
}
export interface ClientFindings {
    version: number;
    scanner: {
        name: string;
        version: string;
        ruleset_id: string;
        ruleset_hash: string;
    };
    scanned: string[];
    findings: Finding[];
}
/** sha256 hex of the canonical `detectors` object, as the spec's `hash_rule` defines. */
export declare function computeRulesetHash(detectorsSpec: {
    detectors: unknown;
}): string;
/** A scanner built from the vendored spec. Immutable. */
export declare class LocalScanner {
    readonly rulesetId: string;
    readonly rulesetHash: string;
    readonly version: string;
    maxBytes: number;
    private readonly d;
    private readonly maxDepth;
    private readonly maxValues;
    private readonly maxCount;
    private readonly maxFindings;
    private readonly steps;
    private readonly categories;
    private readonly pathRegex;
    private readonly pathKeys;
    private readonly hostRegex;
    private readonly hostMax;
    private readonly fields;
    private readonly extraFields;
    private readonly sending;
    private readonly moveTool;
    private readonly moveFields;
    private readonly positional;
    private readonly address;
    private readonly textDomain;
    private readonly scannedOrder;
    constructor(detectorsSpec: unknown, options?: {
        version?: string;
    });
    /** String leaves visited under the bounds, and whether any node was left unvisited. */
    private walk;
    private dlp;
    private sensitivePath;
    private static firstString;
    /** `[host, unparseable]` by the spec's extraction steps. No URL library, so no parser differential. */
    private static hostFromValue;
    private egress;
    private static normal;
    /** Every recipient in a field's value; anything unreadable is UNPARSED. */
    private strings;
    private addressesInText;
    /** detectors.recipient.ambiguous_input: non-ASCII text that Unicode and ASCII engines read differently. */
    private ambiguousRecipientInput;
    private collectRecipients;
    /** Findings, or undefined when the check must be left out (ambiguous input). */
    private recipientFindings;
    /** `{scanned, findings}` for the raw arguments. A check that throws or cannot be answered is left out. Never throws. */
    scan(toolName: string, args: unknown, metadata?: unknown): ScanResult;
    private size;
    /**
     * The `client_findings` request field, or undefined when nothing was scanned.
     * If the report would exceed the server's size or count bound, checks are
     * left out (recipient first, then egress_host) rather than sending a report
     * the server would reject.
     */
    clientFindings(toolName: string, args: unknown, metadata?: unknown): ClientFindings | undefined;
}
/** The scanner built from the vendored spec, or null (logged once) when it cannot be built. */
export declare function loadScanner(): LocalScanner | null;
/** Test hook: forget the cached scanner. */
export declare function resetScannerForTests(): void;
export { spec as detectorSpec };
//# sourceMappingURL=local-scan.d.ts.map