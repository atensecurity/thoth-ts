import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalScanError,
  LocalScanner,
  SCANNER_NAME,
  computeRulesetHash,
  loadScanner,
} from "../local-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const specPath = join(pkgRoot, "src/detectors.v1.json");
const SPEC = JSON.parse(readFileSync(specPath, "utf8"));
const GOLDEN = JSON.parse(
  readFileSync(join(pkgRoot, "testdata/sdk/detectors_golden.v1.json"), "utf8"),
) as { ruleset_hash: string; cases: GoldenCase[] };

interface GoldenCase {
  id: string;
  group: string;
  tool_name: string;
  arguments: unknown;
  metadata?: Record<string, unknown>;
  expected: { scanned: string[]; findings: Array<Record<string, unknown>> };
}

// Changing any detector changes this value on purpose. It is the same pin the
// enforcer and the Python SDK hold; update the spec, the golden, every vendored
// copy and every pin in one pull request.
const PINNED_RULESET_HASH =
  "db797fde60f300719b9dac8a360efd6ce8b1f7313587cc714aebf7a93428434b";

const scanner = new LocalScanner(SPEC, { version: "9.9.9" });

function featuresDir(): string | undefined {
  let current = here;
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(current, "backend/python/libs/features");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

describe("identity and packaging", () => {
  it("carries the pinned ruleset hash and identifies itself", () => {
    expect(computeRulesetHash(SPEC)).toBe(SPEC.ruleset_hash);
    expect(SPEC.ruleset_hash).toBe(PINNED_RULESET_HASH);
    expect(GOLDEN.ruleset_hash).toBe(PINNED_RULESET_HASH);
    const report = scanner.clientFindings("tool", { text: "hello" });
    expect(report?.scanner).toEqual({
      name: SCANNER_NAME,
      version: "9.9.9",
      ruleset_id: "thoth-detectors.v1",
      ruleset_hash: PINNED_RULESET_HASH,
    });
    // The server's scanner name and version constraints.
    expect(SCANNER_NAME).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    expect("9.9.9").toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/);
  });

  it("reports the package version by default", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    const report = new LocalScanner(SPEC).clientFindings("tool", { a: "b" });
    expect(report?.scanner.version).toBe(pkg.version);
  });

  it("refuses a spec that does not match its hash", () => {
    const tampered = JSON.parse(JSON.stringify(SPEC));
    tampered.detectors.dlp.steps[0].pattern = "x";
    expect(() => new LocalScanner(tampered)).toThrow(LocalScanError);
  });

  it("is byte-identical to the shared features copies", () => {
    const features = featuresDir();
    if (!features) return; // the package is built outside the monorepo
    expect(readFileSync(specPath)).toEqual(
      readFileSync(join(features, "thoth_features/detectors.v1.json")),
    );
    expect(
      readFileSync(join(pkgRoot, "testdata/sdk/detectors_golden.v1.json")),
    ).toEqual(
      readFileSync(join(features, "fixtures/detectors_golden.v1.json")),
    );
  });

  it("ships the spec in the source tree and lists src in the package files", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    expect(existsSync(specPath)).toBe(true);
    expect(pkg.files).toContain("src");
    expect(pkg.files).toContain("dist");
  });

  it("loads the scanner from the vendored spec", () => {
    expect(loadScanner()?.rulesetHash).toBe(PINNED_RULESET_HASH);
  });

  it("uses no URL library and none of the u, v, s or m regex flags", () => {
    const source = readFileSync(join(pkgRoot, "src/local-scan.ts"), "utf8");
    expect(source).not.toMatch(/new URL\(\s*(?!"\.\.\/package\.json")/);
    expect(source).not.toMatch(/new RegExp\([^)]*"[^"]*[uvsm][^"]*"\)/);
  });
});

describe("golden fixtures", () => {
  const conformance = GOLDEN.cases.filter(
    (c) => c.group !== "known_divergence",
  );

  it("covers every group", () => {
    const groups = new Set(GOLDEN.cases.map((c) => c.group));
    for (const g of [
      "dlp",
      "bounds",
      "sensitive_path",
      "egress_host",
      "recipient",
      "negative",
      "known_divergence",
      "ambiguous",
    ]) {
      expect(groups.has(g)).toBe(true);
    }
  });

  it.each(conformance.map((c) => [c.id, c] as const))("%s", (_id, entry) => {
    expect(
      scanner.scan(entry.tool_name, entry.arguments, entry.metadata),
    ).toEqual(entry.expected);
  });

  // The server (Python) reads \b \w \d \s as Unicode; this scanner is ASCII, as the
  // spec requires (JavaScript's \b \w \d are ASCII; \s is rewritten to the ASCII
  // class). These are the ASCII answers the spec's notes describe, pinned so a
  // change in engine behaviour shows up. The recorded server answers are not
  // conformance targets.
  describe("known_divergence", () => {
    const ssn = [{ kind: "dlp", category: "ssn", count: 1 }];
    const email = [{ kind: "dlp", category: "email", count: 1 }];
    const asciiAnswers: Record<string, Array<Record<string, unknown>>> = {
      "known_divergence.non_ascii_letter_before_ssn": ssn,
      "known_divergence.cjk_before_email": email,
      "known_divergence.arabic_indic_digits_ssn": [],
      "known_divergence.nbsp_in_phone": [],
      "known_divergence.recipient_kelvin_sign_domain": [
        { kind: "recipient", status: "unresolved", data_move: false },
      ],
    };
    const divergent = GOLDEN.cases.filter(
      (c) => c.group === "known_divergence",
    );

    it("has an ASCII answer for every divergent case", () => {
      expect(new Set(divergent.map((c) => c.id))).toEqual(
        new Set(Object.keys(asciiAnswers)),
      );
    });

    it.each(divergent.map((c) => [c.id, c] as const))("%s", (id, entry) => {
      const got = scanner.scan(
        entry.tool_name,
        entry.arguments,
        entry.metadata,
      );
      expect(got.scanned).toEqual(entry.expected.scanned);
      expect(got.findings).toEqual(asciiAnswers[id]);
    });
  });
});

describe("what leaves the process", () => {
  it("has hostnames and domains, never values or local parts", () => {
    const args = {
      to: "Very.Secret.Name+tag@Corp.Example.com",
      url: "https://user:hunter2@Api.Example.org/path?token=abc",
      path: "/data/patient_records.csv",
      text: "ssn 123-45-6789 password=hunter2",
    };
    const text = JSON.stringify(
      scanner.clientFindings("send_email", args),
    ).toLowerCase();
    for (const leaked of [
      "very.secret",
      "secret.name",
      "hunter2",
      "123-45-6789",
      "patient_records",
      "/data",
      "token=abc",
      "user:",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("corp.example.com");
    expect(text).toContain("api.example.org");
  });

  it("drops checks instead of sending a report the server would reject", () => {
    const local = new LocalScanner(SPEC, { version: "1" });
    const domains = Array.from(
      { length: 10 },
      (_, i) =>
        `a@${"x".repeat(63)}.${"y".repeat(63)}.${"z".repeat(63)}.${"w".repeat(58)}${i}.com`,
    );
    const args = {
      to: [...domains, ...Array(12).fill("Bob")],
      url: "https://evil.example.com/",
    };
    const full = local.clientFindings("send_email", args);
    expect(full?.scanned).toContain("recipient");
    // The real bound is 4096 bytes; a smaller one proves the report is trimmed, not sent half.
    local.maxBytes = Buffer.byteLength(JSON.stringify(full)) - 1;
    const trimmed = local.clientFindings("send_email", args);
    expect(trimmed).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(trimmed))).toBeLessThanOrEqual(
      local.maxBytes,
    );
    expect(trimmed?.scanned).not.toContain("recipient");
    expect(trimmed?.findings.every((f) => f.kind !== "recipient")).toBe(true);
    local.maxBytes = 10;
    expect(local.clientFindings("send_email", args)).toBeUndefined();
  });

  it("sends nothing for arguments that are not an object", () => {
    expect(scanner.clientFindings("tool", ["a", "b"])).toBeUndefined();
    expect(scanner.clientFindings("tool", null)).toBeUndefined();
    expect(scanner.clientFindings("tool", "text")).toBeUndefined();
  });
});

describe("failing closed", () => {
  it("leaves a check that throws out of scanned instead of reporting it clean", () => {
    const local = new LocalScanner(SPEC, { version: "1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (local as any).sensitivePath = () => {
      throw new Error("cannot read CANARY-9f3a");
    };
    const result = local.scan("tool", {
      path: "/x/patient.txt",
      text: "123-45-6789",
    });
    expect(result.scanned).not.toContain("sensitive_path");
    expect(result.findings.some((f) => f.kind === "sensitive_path")).toBe(
      false,
    );
    expect(new Set(result.scanned)).toEqual(
      new Set(["dlp", "egress_host", "recipient"]),
    );
    expect(result.findings).toEqual([
      { kind: "dlp", category: "ssn", count: 1 },
    ]);
    // The warning names the check, never an error message that could quote a value.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("CANARY");
    warn.mockRestore();
  });

  it("sends no report when every check fails", () => {
    const local = new LocalScanner(SPEC, { version: "1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const name of [
      "dlp",
      "sensitivePath",
      "egress",
      "recipientFindings",
    ]) {
      (local as any)[name] = () => {
        throw new Error("x");
      };
    }
    expect(local.clientFindings("tool", { text: "x" })).toBeUndefined();
    warn.mockRestore();
  });

  it("omits dlp and recipient when the walk is truncated by the value budget", () => {
    const result = scanner.scan("send_email", {
      items: Array(6000).fill("x"),
      to: "a@x.com",
    });
    expect(result.scanned).not.toContain("dlp");
    expect(result.scanned).not.toContain("recipient");
    expect(result.scanned).toEqual(
      expect.arrayContaining(["sensitive_path", "egress_host"]),
    );
  });

  it("omits dlp and recipient when the arguments are deeper than 16", () => {
    let deep: unknown = "123-45-6789";
    for (let i = 0; i < 20; i += 1) deep = { n: deep };
    const result = scanner.scan("tool", { deep });
    expect(result.scanned).not.toContain("dlp");
    expect(result.scanned).not.toContain("recipient");
  });

  it("does not hang or throw on a self-referencing argument", () => {
    const loop: Record<string, unknown> = { a: "123-45-6789" };
    loop.self = loop;
    const result = scanner.scan("tool", loop);
    expect(result.scanned).not.toContain("dlp");
  });

  it("leaves recipient out for non-ASCII text the engines read differently", () => {
    const result = scanner.scan(
      "send_email",
      { to: "a@b.com", note: "x" },
      undefined,
    );
    expect(result.scanned).toContain("recipient");
    const ambiguous = scanner.scan("send_email", { "to ": "a@b.com" });
    expect(ambiguous.scanned).not.toContain("recipient");
    expect(ambiguous.findings.filter((f) => f.kind === "recipient")).toEqual(
      [],
    );
  });

  it("treats an unparseable host as unresolved, not as no host", () => {
    for (const url of [
      "https:///x",
      "http://@",
      "//x.example",
      "http://a\\b.example",
      "http://[::1",
    ]) {
      expect(scanner.scan("fetch", { url }).findings).toEqual([
        { kind: "egress_host", verdict: "unresolved" },
      ]);
    }
    expect(scanner.scan("fetch", { url: ":8080" }).findings).toEqual([]);
  });
});
