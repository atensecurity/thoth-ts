// Scan tool arguments on this side and report what was found, never the values.
//
// When tool-argument values are withheld (see data-handling.ts), Thoth cannot
// look at them. This module scans the raw arguments in your process first and
// builds the `client_findings` field of the request: counts, categories,
// hostnames and recipient domains. It implements the shared detector spec
// (detectors.v1.json, vendored next to this file; docs/integrations/
// local-scan-detectors.md in the monorepo explains it) independently in
// TypeScript.
//
// The detectors are heuristic regular expressions. A finding is a signal, not
// proof that data is sensitive, and no finding is not proof that it is not.
// This is not a compliance statement of any kind.
//
// What leaves the process: counts, categories, hostnames and recipient
// domains. Never values, paths, local parts of addresses, display names or
// message text.
//
// Trust is the workspace's call. Thoth cannot verify a client scan; it relies
// on one only when the workspace opted in and listed this ruleset's hash.
// Findings only ever raise a decision.
//
// Failing closed: a check that cannot be completed (a node bound was hit, the
// check threw, the report would not fit) is left out of `scanned` and has no
// findings, so Thoth sees it as missing rather than clean.
//
// Regular expressions are compiled with the engine's own `i` flag and global
// matching, never the `u`, `v`, `s` or `m` flags. JavaScript's \b \w \d are
// ASCII, as the spec requires; its \s is Unicode, so \s in a spec pattern is
// rewritten to the spec's ASCII whitespace class before compiling.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import spec from "./detectors.v1.json" with { type: "json" };
import { canonicalJson } from "./data-handling.js";

// The server accepts [A-Za-z0-9][A-Za-z0-9._-]{0,63}, so the npm scope cannot be part of it.
export const SCANNER_NAME = "atensec-thoth-ts";
export const REPORT_VERSION = 1;

const VERSION_PATTERN = /[^A-Za-z0-9._+-]/g;
const MAX_VERSION_CHARS = 32;
const ASCII_SPACE = " \\t\\n\\v\\f\\r";
// Python's str.isspace set: what the spec calls "any whitespace character".
const UNICODE_SPACE =
  /[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
// Stands for a recipient that could not be read; it never matches an address.
const UNPARSED = "<unparsed>";
const MAX_DOMAIN = 253;
const MAX_LABEL = 63;

type Json = unknown;
type Rec = Record<string, unknown>;

/** The detector spec could not be loaded or does not match its pinned hash. */
export class LocalScanError extends Error {}

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
export function computeRulesetHash(detectorsSpec: {
  detectors: unknown;
}): string {
  return createHash("sha256")
    .update(canonicalJson(detectorsSpec.detectors), "utf8")
    .digest("hex");
}

function sdkVersion(): string {
  let raw = "0";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string") raw = pkg.version;
  } catch {
    // Bundled without package.json: the version is not known.
  }
  const cleaned = raw
    .replace(VERSION_PATTERN, "")
    .slice(0, MAX_VERSION_CHARS)
    .replace(/^[._+-]+/, "");
  return cleaned || "0";
}

// The ASCII reading of \s (spec: regex_dialect.word_boundary).
function asciiSpace(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === "s") out += inClass ? ASCII_SPACE : `[${ASCII_SPACE}]`;
      else if (next === "S") out += inClass ? "" : `[^${ASCII_SPACE}]`;
      else out += ch + (next ?? "");
      i += 1;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return out;
}

function compile(pattern: string, flags: string[], global: boolean): RegExp {
  // Never u/v/s/m (spec: regex_dialect.flags).
  return new RegExp(
    asciiSpace(pattern),
    (flags.includes("i") ? "i" : "") + (global ? "g" : ""),
  );
}

/** Printable ASCII and ASCII whitespace only (detectors.recipient.ambiguous_input). */
function plain(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (!((code >= 0x20 && code <= 0x7e) || (code >= 0x09 && code <= 0x0d)))
      return false;
  }
  return true;
}

/**
 * Spaces Python's str.split(), str.strip() and \s treat as separators but ASCII does not
 * (detectors.recipient.ambiguous_input, clause d).
 */
const PYTHON_ONLY_SPACE = new Set(
  [
    0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
    0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029,
    0x202f, 0x205f, 0x3000,
  ].map((code) => String.fromCharCode(code)),
);

function hasUnicodeSpace(text: string): boolean {
  for (const ch of text) if (PYTHON_ONLY_SPACE.has(ch)) return true;
  return false;
}

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(source: Rec, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key)
    ? source[key]
    : undefined;
}

// Python str.strip() / split() whitespace for values that the spec leaves to the
// host language; recipients with non-ASCII text are already left out of the scan.
const ASCII_WS = /[ \t\n\v\f\r]+/;
function asciiTrim(text: string): string {
  return text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
}
function words(text: string): string[] {
  return asciiTrim(text)
    .split(ASCII_WS)
    .filter((word) => word.length > 0);
}
function blankString(value: string): boolean {
  for (const ch of value) if (!UNICODE_SPACE.test(ch)) return false;
  return true;
}

interface Step {
  category: string;
  regex: RegExp;
  replacement: string;
}

/** A scanner built from the vendored spec. Immutable. */
export class LocalScanner {
  readonly rulesetId: string;
  readonly rulesetHash: string;
  readonly version: string;
  // Settable only so tests can exercise the size bound with a smaller limit.
  maxBytes: number;
  private readonly d: any;
  private readonly maxDepth: number;
  private readonly maxValues: number;
  private readonly maxCount: number;
  private readonly maxFindings: number;
  private readonly steps: Step[];
  private readonly categories: string[];
  private readonly pathRegex: RegExp;
  private readonly pathKeys: string[];
  private readonly hostRegex: RegExp;
  private readonly hostMax: number;
  private readonly fields: Set<string>;
  private readonly extraFields: Set<string>;
  private readonly sending: RegExp;
  private readonly moveTool: RegExp;
  private readonly moveFields: Set<string>;
  private readonly positional: RegExp;
  private readonly address: RegExp;
  private readonly textDomain: RegExp;
  private readonly scannedOrder: string[];

  constructor(detectorsSpec: unknown, options: { version?: string } = {}) {
    const s = detectorsSpec as {
      ruleset_id: string;
      ruleset_hash?: string;
      detectors: any;
    };
    const actual = computeRulesetHash(s);
    if (s.ruleset_hash !== actual)
      throw new LocalScanError("detector spec does not match its ruleset_hash");
    this.rulesetId = s.ruleset_id;
    this.rulesetHash = actual;
    this.version = options.version ?? sdkVersion();
    const d = s.detectors;
    this.d = d;
    this.maxDepth = d.bounds.max_depth;
    this.maxValues = d.bounds.max_values;
    this.maxCount = d.bounds.max_count;
    this.maxFindings = d.bounds.max_findings;
    this.maxBytes = d.bounds.max_payload_bytes;
    this.steps = d.dlp.steps.map((step: any) => ({
      category: step.category,
      regex: compile(step.pattern, step.flags, true),
      replacement: step.replacement,
    }));
    this.categories = d.dlp.categories;
    this.pathRegex = compile(
      d.sensitive_path.pattern,
      d.sensitive_path.flags,
      false,
    );
    this.pathKeys = d.sensitive_path.keys;
    const grammar = d.egress_host.host_grammar;
    this.hostRegex = compile(grammar.pattern, grammar.flags, false);
    this.hostMax = grammar.max_length;
    const rule = d.recipient;
    this.fields = new Set(rule.fields);
    this.extraFields = new Set(rule.extra_fields_for_sending_tools);
    this.sending = compile(
      rule.sending_tool_pattern.pattern,
      rule.sending_tool_pattern.flags,
      false,
    );
    this.moveTool = compile(
      rule.data_move.tool_name_hint.pattern,
      rule.data_move.tool_name_hint.flags,
      false,
    );
    this.moveFields = new Set(rule.data_move.fields);
    this.positional = compile(
      rule.positional_keys.pattern,
      rule.positional_keys.flags,
      false,
    );
    this.address = compile(rule.address.pattern, rule.address.flags, false);
    // Sticky: matched directly after an '@' (the text rule), not searched for.
    this.textDomain = new RegExp(
      asciiSpace(rule.text_domain_pattern.pattern),
      "y",
    );
    this.scannedOrder = d.report.scanned_order;
  }

  // ------------------------------------------------------------------ //
  // Traversal                                                           //
  // ------------------------------------------------------------------ //

  /** String leaves visited under the bounds, and whether any node was left unvisited. */
  private walk(root: Json): { leaves: string[]; truncated: boolean } {
    let budget = this.maxValues;
    const leaves: string[] = [];
    let truncated = false;
    const stack: Array<[Json, number]> = [[root, 0]];
    // Pre-order without recursion: children are pushed reversed so the first is visited first.
    while (stack.length > 0) {
      const [node, depth] = stack.pop() as [Json, number];
      if (depth > this.maxDepth || budget <= 0) {
        truncated = true;
        continue;
      }
      budget -= 1;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i -= 1)
          stack.push([node[i], depth + 1]);
      } else if (isRec(node)) {
        const values = Object.values(node);
        for (let i = values.length - 1; i >= 0; i -= 1)
          stack.push([values[i], depth + 1]);
      } else if (typeof node === "string") {
        leaves.push(node);
      }
    }
    return { leaves, truncated };
  }

  // ------------------------------------------------------------------ //
  // Checks                                                              //
  // ------------------------------------------------------------------ //

  private dlp(leaves: string[]): Finding[] {
    const counts = new Map<string, number>();
    for (const leaf of leaves) {
      let text = leaf;
      for (const step of this.steps) {
        let n = 0;
        // A function replacement keeps the text literal: no $ or group escapes.
        text = text.replace(step.regex, (...m: unknown[]) => {
          n += 1;
          return step.replacement.replace("{group1}", () =>
            typeof m[1] === "string" ? m[1] : "",
          );
        });
        if (n) counts.set(step.category, (counts.get(step.category) ?? 0) + n);
      }
    }
    return this.categories
      .filter((c) => (counts.get(c) ?? 0) > 0)
      .map((c) => ({
        kind: "dlp",
        category: c,
        count: Math.min(counts.get(c) as number, this.maxCount),
      }));
  }

  private sensitivePath(args: Rec): Finding[] {
    const candidates: string[] = [];
    const [first, second] = this.pathKeys as [string, string];
    const one = own(args, first);
    if (typeof one === "string" && one) candidates.push(one);
    const many = own(args, second);
    if (Array.isArray(many))
      for (const item of many)
        if (typeof item === "string" && item) candidates.push(item);
    const count = candidates.filter((c) => this.pathRegex.test(c)).length;
    return count
      ? [{ kind: "sensitive_path", count: Math.min(count, this.maxCount) }]
      : [];
  }

  private static firstString(
    source: unknown,
    keys: string[],
  ): string | undefined {
    if (!isRec(source)) return undefined;
    for (const key of keys) {
      const value = own(source, key);
      if (typeof value === "string" && !blankString(value)) return value;
    }
    return undefined;
  }

  /** `[host, unparseable]` by the spec's extraction steps. No URL library, so no parser differential. */
  private static hostFromValue(value: string): [string, boolean] {
    let text = value.replace(/^ +| +$/g, "");
    for (const ch of text) {
      const code = ch.codePointAt(0) as number;
      if (ch === "\\" || code < 0x20 || code === 0x7f || UNICODE_SPACE.test(ch))
        return ["", true];
    }
    const original = text;
    if (!text.includes("://")) text = `https://${text}`;
    const afterScheme = text.slice(text.indexOf("://") + 3);
    const cut = afterScheme.search(/[/?#]/);
    const authority = cut < 0 ? afterScheme : afterScheme.slice(0, cut);
    const opens = authority.split("[").length - 1;
    const closes = authority.split("]").length - 1;
    if (
      opens !== closes ||
      (authority.includes("[") && !authority.includes("]"))
    )
      return ["", true];
    const hostinfo = authority.slice(authority.lastIndexOf("@") + 1);
    let host = hostinfo.startsWith("[")
      ? hostinfo.slice(1).split("]")[0]
      : hostinfo.split(":")[0];
    host = (host as string).toLowerCase();
    if (
      !host &&
      (original.includes("://") ||
        original.startsWith("//") ||
        original.includes("@"))
    ) {
      return ["", true];
    }
    return [host as string, false];
  }

  private egress(args: Rec, metadata: Rec | undefined): Finding[] {
    let host = "";
    let unparseable = false;
    for (const source of this.d.egress_host.sources) {
      let value: string | undefined;
      if (source.from === "metadata") {
        if (metadata === undefined) continue;
        if ("key" in source) {
          const broker = own(metadata, "secrets_broker");
          const target = isRec(broker) ? own(broker, "target_host") : undefined;
          value =
            typeof target === "string" && !blankString(target)
              ? target
              : undefined;
        } else {
          value = LocalScanner.firstString(metadata, source.first_non_empty_of);
        }
      } else {
        value = LocalScanner.firstString(args, source.first_non_empty_of);
      }
      if (value !== undefined) {
        [host, unparseable] = LocalScanner.hostFromValue(value);
        if (host || unparseable) break;
      }
    }
    if (unparseable) return [{ kind: "egress_host", verdict: "unresolved" }];
    if (!host) return [];
    if (host.length <= this.hostMax && this.hostRegex.test(host)) {
      return [{ kind: "egress_host", verdict: "not_allowlisted", host }];
    }
    return [{ kind: "egress_host", verdict: "unresolved" }];
  }

  // Recipient ----------------------------------------------------------

  private static normal(key: string): string {
    return key.replace(/[_\-\s]/g, "").toLowerCase();
  }

  /** Every recipient in a field's value; anything unreadable is UNPARSED. */
  private strings(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (typeof value === "string") {
      const out: string[] = [];
      for (const raw of value.split(/[,;]/)) {
        const entry = asciiTrim(raw);
        if (!entry) continue;
        const bracketed = [...entry.matchAll(/<([^<>]*)>/g)].map(
          (m) => m[1] as string,
        );
        const rest = words(entry.replace(/<([^<>]*)>/g, " "));
        const loose = rest.filter((word) => word.includes("@"));
        if (bracketed.length || loose.length)
          out.push(...bracketed.map(asciiTrim), ...loose);
        else out.push(...rest);
      }
      return out;
    }
    if (Array.isArray(value))
      return value.flatMap((element) => this.strings(element));
    if (isRec(value)) {
      const addressKeys = new Set([
        "email",
        "address",
        "emailaddress",
        "value",
        "mail",
      ]);
      const displayKeys = new Set([
        "name",
        "displayname",
        "firstname",
        "lastname",
        "fullname",
        "type",
        "role",
        "label",
      ]);
      const addresses: string[] = [];
      const other: string[] = [];
      for (const [key, element] of Object.entries(value)) {
        const name = LocalScanner.normal(key);
        if (addressKeys.has(name)) addresses.push(...this.strings(element));
        else if (
          !displayKeys.has(name) ||
          typeof element !== "string" ||
          element.includes("@")
        ) {
          other.push(...this.strings(element));
        }
      }
      const found = [
        ...addresses.filter((item) => item !== UNPARSED),
        ...other.filter((item) => item.includes("@")),
      ];
      const unreadable =
        !addresses.some((item) => item.includes("@")) ||
        [...addresses, ...other].some((item) => !item.includes("@"));
      return unreadable ? [...found, UNPARSED] : found;
    }
    return [UNPARSED];
  }

  private addressesInText(value: unknown): string[] {
    if (typeof value === "string") {
      if (!value.includes("@")) return [];
      const out: string[] = [];
      let i = 0;
      while (i < value.length) {
        const at = value.indexOf("@", i);
        if (at < 0) break;
        let matched = false;
        // The '@' must follow a non-whitespace character.
        if (at > 0 && !/[ \t\n\v\f\r]/.test(value[at - 1] as string)) {
          this.textDomain.lastIndex = at + 1;
          const m = this.textDomain.exec(value);
          if (m) {
            const domain = m[0];
            const tooLong =
              domain.length > MAX_DOMAIN ||
              domain.split(".").some((label) => label.length > MAX_LABEL);
            out.push(tooLong ? UNPARSED : `recipient@${domain}`);
            i = at + 1 + domain.length;
            matched = true;
          }
        }
        if (!matched) i = at + 1;
      }
      return out;
    }
    if (Array.isArray(value))
      return value.flatMap((item) => this.addressesInText(item));
    return [];
  }

  /** detectors.recipient.ambiguous_input: non-ASCII text that Unicode and ASCII engines read differently. */
  private ambiguousRecipientInput(
    toolName: string,
    args: Json,
    fields: Set<string>,
    sending: boolean,
  ): boolean {
    if (!plain(toolName)) return true;
    const keysPlain = (value: Json): boolean => {
      if (isRec(value))
        return Object.entries(value).every(
          ([key, item]) => plain(key) && keysPlain(item),
        );
      if (Array.isArray(value)) return value.every(keysPlain);
      if (typeof value === "string") return !hasUnicodeSpace(value);
      return true;
    };
    const textPlain = (value: Json): boolean => {
      if (typeof value === "string")
        return !value.includes("@") || plain(value);
      if (Array.isArray(value)) return value.every(textPlain);
      return true;
    };
    const ambiguous = (value: Json): boolean => {
      if (isRec(value)) {
        for (const [key, item] of Object.entries(value)) {
          if (!plain(key)) return true;
          const name = LocalScanner.normal(key);
          if (fields.has(name)) {
            if (!keysPlain(item)) return true;
            continue;
          }
          if (sending && this.positional.test(name) && !textPlain(item))
            return true;
          if (ambiguous(item)) return true;
        }
      } else if (Array.isArray(value)) {
        return value.some(ambiguous);
      }
      return false;
    };
    return ambiguous(args);
  }

  private collectRecipients(
    args: Json,
    fields: Set<string>,
    sending: boolean,
  ): { found: string[]; dataField: boolean } {
    const found: string[] = [];
    let dataField = false;
    const walk = (value: Json): void => {
      if (isRec(value)) {
        for (const [key, item] of Object.entries(value)) {
          const name = LocalScanner.normal(key);
          if (fields.has(name)) {
            found.push(...this.strings(item));
            dataField = dataField || this.moveFields.has(name);
          } else {
            if (sending && this.positional.test(name))
              found.push(...this.addressesInText(item));
            walk(item);
          }
        }
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item);
      }
    };
    walk(args);
    return { found, dataField };
  }

  /** Findings, or undefined when the check must be left out (ambiguous input). */
  private recipientFindings(
    toolName: string,
    args: Json,
  ): Finding[] | undefined {
    const sending = this.sending.test(toolName || "");
    const fields = sending
      ? new Set([...this.fields, ...this.extraFields])
      : this.fields;
    if (this.ambiguousRecipientInput(toolName || "", args, fields, sending))
      return undefined;
    const { found, dataField } = this.collectRecipients(args, fields, sending);
    const dataMove = this.moveTool.test(toolName || "") || dataField;
    const rule = this.d.recipient;
    const domains: string[] = [];
    let unresolved = 0;
    for (const value of found) {
      const match =
        value === UNPARSED ? null : this.address.exec(asciiTrim(value));
      const domain = match ? (match[1] as string).toLowerCase() : "";
      if (
        domain &&
        domain.length <= this.hostMax &&
        domain.includes(".") &&
        this.hostRegex.test(domain)
      ) {
        if (!domains.includes(domain)) domains.push(domain);
      } else {
        unresolved += 1;
      }
    }
    const out: Finding[] = [];
    if (domains.length) {
      out.push({
        kind: "recipient",
        status: "outside",
        data_move: dataMove,
        domains: domains.slice(0, rule.max_domains),
      });
    }
    const extra = (domains.length > rule.max_domains ? 1 : 0) + unresolved;
    for (let i = 0; i < Math.min(extra, rule.max_unresolved_findings); i += 1) {
      out.push({
        kind: "recipient",
        status: "unresolved",
        data_move: dataMove,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // Report                                                              //
  // ------------------------------------------------------------------ //

  /** `{scanned, findings}` for the raw arguments. A check that throws or cannot be answered is left out. Never throws. */
  scan(toolName: string, args: unknown, metadata?: unknown): ScanResult {
    if (!isRec(args)) return { scanned: [], findings: [] };
    const meta = isRec(metadata) ? metadata : undefined;
    const results = new Map<string, Finding[]>();
    const run = (check: string, fn: () => Finding[] | undefined): void => {
      try {
        const found = fn();
        if (found !== undefined) results.set(check, found);
      } catch {
        // Type only: an error message could quote a value.
        console.warn(
          `thoth: local scan check ${check} failed; reporting it as not scanned`,
        );
      }
    };
    let bounded: { leaves: string[]; truncated: boolean } | undefined;
    const leaves = (): { leaves: string[]; truncated: boolean } =>
      (bounded ??= this.walk(args));
    run("dlp", () => {
      const walked = leaves();
      return walked.truncated ? undefined : this.dlp(walked.leaves);
    });
    run("sensitive_path", () => this.sensitivePath(args));
    run("egress_host", () => this.egress(args, meta));
    run("recipient", () =>
      leaves().truncated ? undefined : this.recipientFindings(toolName, args),
    );
    return {
      scanned: this.scannedOrder.filter((check) => results.has(check)),
      findings: this.scannedOrder.flatMap((check) => results.get(check) ?? []),
    };
  }

  private size(payload: unknown): number {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  /**
   * The `client_findings` request field, or undefined when nothing was scanned.
   * If the report would exceed the server's size or count bound, checks are
   * left out (recipient first, then egress_host) rather than sending a report
   * the server would reject.
   */
  clientFindings(
    toolName: string,
    args: unknown,
    metadata?: unknown,
  ): ClientFindings | undefined {
    let result: ScanResult;
    try {
      result = this.scan(toolName, args, metadata);
    } catch {
      console.warn("thoth: local scan failed; sending no findings");
      return undefined;
    }
    const scanner = {
      name: SCANNER_NAME,
      version: this.version,
      ruleset_id: this.rulesetId,
      ruleset_hash: this.rulesetHash,
    };
    let scanned = [...result.scanned];
    let findings = [...result.findings];
    for (const drop of [undefined, "recipient", "egress_host"] as const) {
      if (drop !== undefined) {
        scanned = scanned.filter((check) => check !== drop);
        findings = findings.filter((finding) => finding.kind !== drop);
      }
      const payload: ClientFindings = {
        version: REPORT_VERSION,
        scanner,
        scanned,
        findings,
      };
      if (
        findings.length <= this.maxFindings &&
        this.size(payload) <= this.maxBytes
      ) {
        return scanned.length ? payload : undefined;
      }
    }
    return undefined;
  }
}

let loaded: LocalScanner | null | undefined;

/** The scanner built from the vendored spec, or null (logged once) when it cannot be built. */
export function loadScanner(): LocalScanner | null {
  if (loaded === undefined) {
    try {
      loaded = new LocalScanner(spec);
    } catch {
      console.warn(
        "thoth: local scan is unavailable (detector spec could not be loaded); sending no findings",
      );
      loaded = null;
    }
  }
  return loaded;
}

/** Test hook: forget the cached scanner. */
export function resetScannerForTests(): void {
  loaded = undefined;
}

export { spec as detectorSpec };
