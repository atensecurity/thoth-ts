/**
 * MCP client integration for @atensec/thoth.
 *
 * Governs every tool call an MCP client (`@modelcontextprotocol/sdk`) makes,
 * whatever framework or loop drives it: the AI SDK's and LangChain.js's MCP
 * adapters, and your own code, all call `client.callTool`. Tools are governed
 * by name as they are first called, in one Thoth session, so an MCP server's
 * tools need no listing up front.
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { governMcpClient } from "@atensec/thoth/mcp";
 *
 * const client = governMcpClient(new Client({ name: "trader", version: "1.0.0" }), {
 *   agentId: "trader",
 *   tenantId: process.env.THOTH_TENANT_ID!,
 *   approvedScope: [],
 *   userId,
 * });
 * await client.connect(transport);
 * await client.callTool({ name: "list_orders", arguments: { account: "A-1" } });
 * ```
 *
 * A refused call rejects with ThothPolicyViolation and never reaches the MCP
 * server. When a governed framework tool calls this client for the same tool
 * with the same arguments Thoth just checked, that one call isn't checked a
 * second time; any other call inside it is.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { claimCheckedCall, openSession } from "../instrumentor.js";
import type { ThothConfig } from "../models.js";
import { jsonSchemaOf } from "./govern.js";

interface ListedTool {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

/** The parts of an MCP client this integration uses. */
export interface McpClientLike {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    ...rest: never[]
  ): Promise<unknown>;
  listTools?(...args: never[]): Promise<{
    tools?: { name?: string; description?: string; inputSchema?: unknown }[];
  }>;
}

type CallParams = {
  name: string;
  arguments?: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Governs `client.callTool` (and reports listed tools to the tool inventory).
 * Returns the same client. Govern one client per session, for example per
 * request with that request's `userId`.
 */
export function governMcpClient<C extends McpClientLike>(
  client: C,
  config: ThothConfig,
): C {
  const session = openSession(config);
  const original = client.callTool.bind(client) as (
    params: CallParams,
    ...rest: unknown[]
  ) => Promise<unknown>;
  // The call's other parts: everything in params but its arguments, and the
  // result schema and request options, which never go to Thoth.
  const call = new AsyncLocalStorage<{ params: CallParams; rest: unknown[] }>();
  const governed = new Map<string, (...args: unknown[]) => unknown>();

  const callTool = (params: CallParams, ...rest: unknown[]) => {
    const name = params?.name;
    // A call without a tool name names no tool to run; the server refuses it.
    // A governed wrapper's own call goes through unchecked once, exactly as checked.
    if (
      typeof name !== "string" ||
      !name ||
      claimCheckedCall(name, params.arguments ?? {})
    ) {
      return original(params, ...rest);
    }
    let run = governed.get(name);
    if (!run) {
      run = session.wrap(name, (checked: unknown) => {
        const current = call.getStore();
        return original(
          {
            ...(current?.params ?? params),
            arguments: checked as Record<string, unknown>,
          },
          ...(current?.rest ?? rest),
        );
      });
      governed.set(name, run);
    }
    const governedRun = run;
    return call.run({ params, rest }, () =>
      Promise.resolve(governedRun(params.arguments ?? {})),
    );
  };
  (client as { callTool: unknown }).callTool = callTool;

  const listTools = client.listTools?.bind(client) as
    | ((...args: unknown[]) => Promise<{ tools?: ListedTool[] }>)
    | undefined;
  if (listTools) {
    const reported = new Set<string>();
    (client as { listTools: unknown }).listTools = async (
      ...args: unknown[]
    ) => {
      const result = await listTools(...args);
      const fresh = (result?.tools ?? []).filter(
        (tool) => typeof tool.name === "string" && !reported.has(tool.name),
      );
      for (const tool of fresh) reported.add(tool.name as string);
      if (fresh.length) {
        session.report(
          fresh.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: jsonSchemaOf(tool.inputSchema),
          })),
        );
      }
      return result;
    };
  }
  return client;
}
