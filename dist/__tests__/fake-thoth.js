import { vi } from "vitest";
export const apiUrl = "https://enforce.example.test";
/**
 * The enforcer over fetch, for integration tests: records every check and
 * answers per tool ("ALLOW" unless set). Other Thoth calls succeed empty.
 */
export function fakeThoth() {
    const checks = [];
    const decisions = {};
    const inventory = [];
    const fetchMock = vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path === "/v1/enforce") {
            checks.push(body);
            const decision = decisions[body.tool_name] ?? "ALLOW";
            return Response.json({ decision, reason: `${decision} by test policy` });
        }
        if (path.endsWith("/thoth/tool-inventory"))
            inventory.push(body);
        return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { checks, decisions, inventory, fetchMock };
}
//# sourceMappingURL=fake-thoth.js.map