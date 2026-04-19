import { EnforcementDecision, ThothConfig } from "./models";
type EnforceConfig = Required<Pick<ThothConfig, "agentId" | "approvedScope" | "tenantId" | "userId" | "enforcement" | "apiKey" | "apiUrl" | "stepUpTimeoutMinutes" | "stepUpPollIntervalMs">> & Pick<ThothConfig, "sessionIntent" | "policyContext" | "enforcementTraceId">;
export declare function checkEnforce(config: EnforceConfig, toolName: string, sessionId: string, sessionToolCalls: string[], toolArgs?: Record<string, unknown>, enforcementTraceId?: string): Promise<EnforcementDecision>;
export {};
//# sourceMappingURL=enforcer-client.d.ts.map