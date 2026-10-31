import { vi } from "vitest";

export const apiUrl = "https://enforce.example.test";

export interface Check {
  tool_name: string;
  tool_args?: Record<string, unknown>;
  user_id?: string;
  session_id?: string;
  session_tool_calls?: string[];
}

/**
 * The enforcer over fetch, for integration tests: records every check and
 * answers per tool ("ALLOW" unless set). Other Thoth calls succeed empty.
 */
export function fakeThoth() {
  const checks: Check[] = [];
  const decisions: Record<string, string> = {};
  const inventory: { tools: { name: string; input_schema: unknown }[] }[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/enforce") {
      checks.push(body as Check);
      const decision = decisions[body.tool_name] ?? "ALLOW";
      return Response.json({ decision, reason: `${decision} by test policy` });
    }
    if (path.endsWith("/thoth/tool-inventory")) inventory.push(body);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { checks, decisions, inventory, fetchMock };
}
