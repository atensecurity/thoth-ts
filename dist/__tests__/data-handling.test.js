import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as dh from "../data-handling.js";
import { checkEnforce, requestHumanExplanation } from "../enforcer-client.js";
import { instrument } from "../instrumentor.js";
import { DecisionType, EnforcementMode, ThothPolicyViolation, } from "../models.js";
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN = JSON.parse(readFileSync(join(pkgRoot, "testdata/sdk/data_handling_golden.json"), "utf8"));
const SALT = "test-salt-1";
const CANARY = "CANARY-9f3a-secret-value";
const ENV_NAMES = [
    "THOTH_DATA_HANDLING_TOOL_ARGUMENTS",
    "THOTH_DATA_HANDLING_PROMPTS",
    "THOTH_DATA_HANDLING_SALT",
    "THOTH_DATA_HANDLING_LOCAL_SCAN",
];
const ARGS = {
    path: "/tmp/report.txt",
    note: `ssn 123-45-6789 ${CANARY}`,
    nested: { count: 3, flag: true, none: null },
};
beforeEach(() => {
    for (const name of ENV_NAMES)
        delete process.env[name];
});
afterEach(() => {
    for (const name of ENV_NAMES)
        delete process.env[name];
    vi.unstubAllGlobals();
});
function buildConfig(overrides = {}) {
    return {
        agentId: "agent_1",
        approvedScope: ["read_file"],
        tenantId: "tenant_1",
        userId: "system",
        enforcement: EnforcementMode.BLOCK,
        apiKey: "thoth_test_key",
        apiUrl: "https://enforce.example.test",
        stepUpTimeoutMinutes: 1,
        stepUpPollIntervalMs: 1,
        environment: "prod",
        failOpen: false,
        ...overrides,
    };
}
/** A fake transport that records every request body and answers with a fixed decision. */
function wire(response = { decision: "ALLOW" }) {
    const requests = [];
    const fetchMock = vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        const raw = init?.body ? String(init.body) : "";
        requests.push({ path, body: raw ? JSON.parse(raw) : {}, raw });
        if (path === "/v1/explain") {
            return Response.json({
                violation_id: "v1",
                what_happened: "w",
                why_it_was_blocked: "y",
                what_to_do_next: "n",
                business_impact: "b",
                severity: "low",
            });
        }
        return Response.json(response);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
        bodies: (path) => requests.filter((r) => r.path === path).map((r) => r.body),
        raw: () => requests.map((r) => r.raw).join("\n"),
    };
}
describe("golden fixture", () => {
    const cases = GOLDEN.cases.map((c) => [c.name, c]);
    it.each(cases)("%s", (_name, entry) => {
        const { kind, mode, salt, input } = entry;
        if (kind === "tool_arguments") {
            const [keep, out] = dh.transformArguments(input, mode, salt);
            if ("expected_omitted" in entry) {
                expect(keep).toBe(false);
            }
            else {
                expect(keep).toBe(true);
                expect(dh.canonicalJson(out)).toBe(dh.canonicalJson(entry.expected));
            }
        }
        else if (kind === "prompt") {
            const [keep, out] = dh.transformPrompt(input, mode, salt);
            if ("expected_omitted" in entry) {
                expect(keep).toBe(false);
            }
            else {
                expect(keep).toBe(true);
                expect(out).toEqual(entry.expected);
            }
        }
        else {
            expect(dh.canonicalJson(dh.transformContext(input, mode, salt))).toBe(dh.canonicalJson(entry.expected));
        }
    });
});
describe("transforms", () => {
    it("does not modify its input", () => {
        const value = JSON.parse(JSON.stringify(ARGS));
        const snapshot = JSON.stringify(value);
        dh.hashArguments(value, SALT);
        dh.redactArguments(value);
        expect(JSON.stringify(value)).toBe(snapshot);
    });
    it("never lets an original value through past the bounds", () => {
        let deep = `${CANARY}-deep`;
        for (let i = 0; i < 20; i += 1)
            deep = { n: deep };
        expect(JSON.stringify(dh.redactArguments(deep))).not.toContain("CANARY");
        expect(JSON.stringify(dh.hashArguments(deep, SALT))).toContain(dh.TRUNCATED);
        const wide = Array.from({ length: 6000 }, (_, i) => `secret-${i}`);
        const out = dh.hashArguments(wide, SALT);
        expect(out.at(-1)).toBe(dh.TRUNCATED);
        expect(JSON.stringify(out)).not.toContain("secret-");
        const keys = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, `secret-${i}`]));
        const wideObject = dh.redactArguments(keys);
        expect(wideObject["_truncated"]).toBe(dh.TRUNCATED);
    });
    it("keeps a __proto__ key as data", () => {
        const value = JSON.parse('{"__proto__": {"a": "x"}, "b": "y"}');
        const out = dh.redactArguments(value);
        expect(Object.keys(out)).toEqual(["__proto__", "b"]);
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });
    it("hashes with a salt: same salt and value match, another salt does not", () => {
        expect(dh.hashValue("a", "x")).toBe(dh.hashValue("a", "x"));
        expect(dh.hashValue("a", "x")).not.toBe(dh.hashValue("b", "x"));
        expect(dh.hashValue("a", "x")).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    });
    it("sorts canonical keys by code point, not UTF-16 unit", () => {
        // U+FF5E (BMP) sorts before U+1F600 (astral) by code point; UTF-16 units say the opposite.
        expect(dh.canonicalJson({ "\u{1f600}": 1, "～": 2 })).toBe('{"～":2,"\u{1f600}":1}');
    });
});
describe("configuration", () => {
    it("is off when nothing is set", () => {
        expect(dh.DataHandling.resolve({})).toBeUndefined();
        expect(dh.argumentsWithheld({})).toBe(false);
    });
    it("reads options and the environment, options first", () => {
        process.env.THOTH_DATA_HANDLING_TOOL_ARGUMENTS = " REDACT ";
        expect(dh.DataHandling.resolve({})?.toolArguments).toBe("redact");
        expect(dh.DataHandling.resolve({ dataHandlingToolArguments: "drop" })
            ?.toolArguments).toBe("drop");
        process.env.THOTH_DATA_HANDLING_PROMPTS = "hash";
        expect(dh.DataHandling.resolve({})?.prompts).toBe("hash");
        process.env.THOTH_DATA_HANDLING_SALT = "env-salt";
        expect(dh.DataHandling.resolve({})?.salt).toBe("env-salt");
        expect(dh.DataHandling.resolve({ dataHandlingSalt: "opt-salt" })?.salt).toBe("opt-salt");
    });
    it("uses one random salt per process when none is set", () => {
        const a = dh.DataHandling.resolve({ dataHandlingToolArguments: "hash" });
        const b = dh.DataHandling.resolve({ dataHandlingToolArguments: "hash" });
        expect(a?.salt).toBe(b?.salt);
        expect(a?.salt).toMatch(/^[0-9a-f]{64}$/);
    });
    it.each([
        [{ dataHandlingToolArguments: "scramble" }],
        [{ dataHandlingToolArguments: "hash", dataHandlingPrompts: "redact" }],
        [{ dataHandlingPrompts: "bogus" }],
    ])("rejects an invalid mode instead of sending values unprotected: %j", (options) => {
        expect(() => dh.DataHandling.resolve(options)).toThrow(/Thoth will not send the values unprotected/);
    });
    it("rejects an invalid environment value and an unclear local scan switch", () => {
        process.env.THOTH_DATA_HANDLING_TOOL_ARGUMENTS = "nope";
        expect(() => dh.DataHandling.resolve({})).toThrow();
        delete process.env.THOTH_DATA_HANDLING_TOOL_ARGUMENTS;
        process.env.THOTH_DATA_HANDLING_LOCAL_SCAN = "maybe";
        expect(() => dh.resolveLocalScan(undefined)).toThrow();
    });
    it("fails when the client is built, not on a call", () => {
        wire();
        expect(() => instrument({ tools: [] }, {
            agentId: "a",
            tenantId: "t",
            approvedScope: [],
            dataHandlingToolArguments: "scramble",
        })).toThrow();
    });
    it("scans locally by default whenever arguments are withheld", () => {
        expect(dh.resolveLocalScan(undefined)).toBe(true);
        for (const off of ["off", "false", "0", "no", false])
            expect(dh.resolveLocalScan(off)).toBe(false);
        for (const on of ["on", "true", "1", "yes", true])
            expect(dh.resolveLocalScan(on)).toBe(true);
    });
});
describe("on the wire", () => {
    it.each(["hash", "redact", "drop"])("enforce withholds values and declares it (%s)", async (mode) => {
        const w = wire();
        const args = { ...ARGS, email: "x", url: "https://Evil.Example.com/x" };
        await checkEnforce(buildConfig({
            dataHandlingToolArguments: mode,
            dataHandlingSalt: SALT,
        }), "read_file", "s", ["read_file"], args);
        const [body] = w.bodies("/v1/enforce");
        expect(body.data_handling).toEqual({
            tool_arguments: mode,
            applied_at: "client",
            version: 1,
        });
        if (mode === "drop")
            expect("tool_args" in body).toBe(false);
        if (mode === "redact")
            expect(body.tool_args.nested).toEqual({
                count: "<redacted>",
                flag: "<redacted>",
                none: "<redacted>",
            });
        if (mode === "hash") {
            expect(body.tool_args.path).toBe(dh.hashValue(SALT, "/tmp/report.txt"));
            expect(body.tool_args.nested.none).toBeNull();
            expect(body.tool_args.nested.count).toBe(dh.hashValue(SALT, 3));
        }
        const findings = body.client_findings;
        expect(findings.version).toBe(1);
        expect(findings.scanner.ruleset_hash).toBe("db797fde60f300719b9dac8a360efd6ce8b1f7313587cc714aebf7a93428434b");
        expect(findings.scanner.ruleset_id).toBe("thoth-detectors.v1");
        expect(findings.scanned).toEqual([
            "dlp",
            "sensitive_path",
            "egress_host",
            "recipient",
        ]);
        expect(findings.findings).toEqual([
            { kind: "dlp", category: "ssn", count: 1 },
            {
                kind: "egress_host",
                verdict: "not_allowlisted",
                host: "evil.example.com",
            },
        ]);
        expect(w.raw()).not.toContain(CANARY);
        expect(w.raw()).not.toContain("123-45-6789");
    });
    it("explain carries the same data handling and findings", async () => {
        const w = wire();
        const config = buildConfig({
            dataHandlingToolArguments: "redact",
            dataHandlingSalt: SALT,
        });
        await requestHumanExplanation(config, { decision: DecisionType.BLOCK, reason: "r", violationId: "v1" }, "read_file", "s", ["read_file"], { text: `123-45-6789 ${CANARY}` });
        const [body] = w.bodies("/v1/explain");
        expect(body.data_handling).toEqual({
            tool_arguments: "redact",
            applied_at: "client",
            version: 1,
        });
        expect(body.tool_args).toEqual({ text: "<redacted>" });
        expect(body.client_findings.findings).toEqual([
            { kind: "dlp", category: "ssn", count: 1 },
        ]);
        expect(body.violation_id).toBe("v1");
        expect(w.raw()).not.toContain(CANARY);
    });
    it("still reports the scan for a call with no arguments", async () => {
        const w = wire();
        await checkEnforce(buildConfig({ dataHandlingToolArguments: "drop" }), "list_things", "s", [], undefined);
        const [body] = w.bodies("/v1/enforce");
        expect(body.client_findings.scanned).toEqual([
            "dlp",
            "sensitive_path",
            "egress_host",
            "recipient",
        ]);
        expect(body.client_findings.findings).toEqual([]);
    });
    it("changes nothing when data handling is unset", async () => {
        const w = wire();
        await checkEnforce(buildConfig(), "read_file", "s", [], {
            text: "123-45-6789",
        });
        const [body] = w.bodies("/v1/enforce");
        expect("client_findings" in body).toBe(false);
        expect("data_handling" in body).toBe(false);
        expect(body.tool_args).toEqual({ text: "123-45-6789" });
    });
    it("with prompts only, sends arguments as before, no findings, and hashes prompt-bearing context", async () => {
        const w = wire();
        await checkEnforce(buildConfig({
            dataHandlingPrompts: "hash",
            dataHandlingSalt: SALT,
            taskContext: { task_id: "t-1", goal: "email the board", chain: ["a"] },
        }), "read_file", "s", [], { text: "123-45-6789" });
        const [body] = w.bodies("/v1/enforce");
        expect(body.tool_args).toEqual({ text: "123-45-6789" });
        expect("client_findings" in body).toBe(false);
        expect(body.data_handling).toEqual({
            prompts: "hash",
            applied_at: "client",
            version: 1,
        });
        expect(body.task_context).toEqual({
            task_id: "t-1",
            goal: dh.hashValue(SALT, "email the board"),
            chain: ["a"],
        });
    });
    it.each(["off", "false", "0"])("local scan can be turned off with the environment (%s)", async (value) => {
        process.env.THOTH_DATA_HANDLING_LOCAL_SCAN = value;
        const w = wire();
        await checkEnforce(buildConfig({ dataHandlingToolArguments: "redact" }), "read_file", "s", [], { text: "123-45-6789" });
        const [body] = w.bodies("/v1/enforce");
        expect("client_findings" in body).toBe(false);
        expect(body.data_handling.tool_arguments).toBe("redact");
    });
    it("local scan can be turned off with the option", async () => {
        const w = wire();
        await checkEnforce(buildConfig({
            dataHandlingToolArguments: "redact",
            dataHandlingLocalScan: false,
        }), "read_file", "s", [], { text: "123-45-6789" });
        expect("client_findings" in w.bodies("/v1/enforce")[0]).toBe(false);
    });
    it("reads the environment variables for the whole configuration", async () => {
        process.env.THOTH_DATA_HANDLING_TOOL_ARGUMENTS = "hash";
        process.env.THOTH_DATA_HANDLING_SALT = SALT;
        const w = wire();
        await checkEnforce(buildConfig(), "read_file", "s", [], { text: "x" });
        expect(w.bodies("/v1/enforce")[0].tool_args.text).toBe(dh.hashValue(SALT, "x"));
    });
    it("an invalid setting throws rather than falling back to sending values", async () => {
        const w = wire();
        await expect(checkEnforce(buildConfig({ dataHandlingToolArguments: "scramble" }), "read_file", "s", [], { text: CANARY })).rejects.toThrow();
        expect(w.raw()).toBe("");
    });
    it("a scan that fails is reported as not scanned, never clean, and the values are still withheld", async () => {
        const { loadScanner } = await import("../local-scan.js");
        const scanner = loadScanner();
        const original = scanner.dlp;
        scanner.dlp = () => {
            throw new Error("x");
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            const w = wire();
            await checkEnforce(buildConfig({ dataHandlingToolArguments: "redact" }), "read_file", "s", [], { text: `123-45-6789 ${CANARY}` });
            const [body] = w.bodies("/v1/enforce");
            expect(body.client_findings.scanned).not.toContain("dlp");
            expect(body.client_findings.findings).toEqual([]);
            expect(body.tool_args).toEqual({ text: "<redacted>" });
            expect(w.raw()).not.toContain(CANARY);
        }
        finally {
            scanner.dlp = original;
            warn.mockRestore();
        }
    });
});
describe("through instrument()", () => {
    const apiUrl = "https://enforce.example.test";
    class Tool {
        constructor() {
            this.name = "read_file";
            this.calls = [];
        }
        run(...args) {
            this.calls.push(args);
            return "result";
        }
    }
    it("never sends the raw arguments anywhere, and the tool still gets them", async () => {
        const w = wire();
        const agent = { tools: [new Tool()] };
        instrument(agent, {
            agentId: "a",
            tenantId: "t",
            apiUrl,
            approvedScope: ["read_file"],
            dataHandlingToolArguments: "hash",
            dataHandlingSalt: SALT,
        });
        await agent.tools[0].run({ path: "/tmp/x", note: CANARY });
        expect(agent.tools[0].calls).toEqual([[{ path: "/tmp/x", note: CANARY }]]);
        expect(w.raw()).not.toContain(CANARY);
        expect(w.bodies("/v1/enforce")[0].client_findings.scanned).toContain("dlp");
    });
    it("refuses a MODIFY for withheld arguments: the tool does not run", async () => {
        const w = wire({
            decision: "ALLOW",
            authorization_decision: "MODIFY",
            modified_tool_args: { input: "hashed-nonsense" },
        });
        const agent = { tools: [new Tool()] };
        instrument(agent, {
            agentId: "a",
            tenantId: "t",
            apiUrl,
            approvedScope: ["read_file"],
            dataHandlingToolArguments: "hash",
        });
        const error = await agent.tools[0].run("original").catch((e) => e);
        expect(error).toBeInstanceOf(ThothPolicyViolation);
        expect(error.message).toMatch(/argument rewrite although argument values were withheld/);
        expect(agent.tools[0].calls).toHaveLength(0);
        expect(w.bodies("/v1/enforce")).toHaveLength(1);
    });
    it("refuses a rewrite that arrives with an approved hold", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith("/v1/enforce/hold/"))
                return Response.json({ resolved: true, resolution: "ALLOW" });
            if (path === "/v1/enforce") {
                return Response.json({
                    decision: "STEP_UP",
                    authorization_decision: "STEP_UP",
                    hold_token: "h1",
                    modified_tool_args: { input: "x" },
                });
            }
            return new Response(null, { status: 404 });
        }));
        const agent = { tools: [new Tool()] };
        instrument(agent, {
            agentId: "a",
            tenantId: "t",
            apiUrl,
            approvedScope: ["read_file"],
            stepUpPollIntervalMs: 1,
            dataHandlingToolArguments: "redact",
        });
        await expect(agent.tools[0].run("original")).rejects.toThrow(ThothPolicyViolation);
        expect(agent.tools[0].calls).toHaveLength(0);
    });
    it("still applies a MODIFY when nothing is withheld", async () => {
        wire({
            decision: "ALLOW",
            authorization_decision: "MODIFY",
            modified_tool_args: { input: "sanitized" },
        });
        const agent = { tools: [new Tool()] };
        instrument(agent, {
            agentId: "a",
            tenantId: "t",
            apiUrl,
            approvedScope: ["read_file"],
        });
        await agent.tools[0].run("original");
        expect(agent.tools[0].calls).toEqual([["sanitized"]]);
    });
    it("explains an args_withheld hold in the violation", async () => {
        wire({
            decision: "BLOCK",
            decision_reason_code: "args_withheld",
            reason: "needs values",
        });
        const agent = { tools: [new Tool()] };
        instrument(agent, {
            agentId: "a",
            tenantId: "t",
            apiUrl,
            approvedScope: ["read_file"],
            dataHandlingToolArguments: "redact",
        });
        const error = (await agent.tools[0].run("x").catch((e) => e));
        expect(error).toBeInstanceOf(ThothPolicyViolation);
        expect(error.reason).toContain("[args_withheld:");
        expect(error.reason).toContain("THOTH_DATA_HANDLING_TOOL_ARGUMENTS");
    });
});
//# sourceMappingURL=data-handling.test.js.map