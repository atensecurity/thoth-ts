import { EnforcementDecision, ThothConfig } from "./models";
type EnforceConfig = Required<Pick<ThothConfig, "agentId" | "approvedScope" | "tenantId" | "userId" | "enforcement" | "apiKey" | "apiUrl" | "stepUpTimeoutMinutes" | "stepUpPollIntervalMs">> & Pick<ThothConfig, "sessionIntent">;
export declare function checkEnforce(config: EnforceConfig, toolName: string, sessionId: string, sessionToolCalls: string[]): Promise<EnforcementDecision>;
export {};
//# sourceMappingURL=enforcer-client.d.ts.map