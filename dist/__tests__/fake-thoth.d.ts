export declare const apiUrl = "https://enforce.example.test";
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
export declare function fakeThoth(): {
    checks: Check[];
    decisions: Record<string, string>;
    inventory: {
        tools: {
            name: string;
            input_schema: unknown;
        }[];
    }[];
    fetchMock: import("vitest").Mock<(url: unknown, init?: RequestInit) => Promise<Response>>;
};
//# sourceMappingURL=fake-thoth.d.ts.map