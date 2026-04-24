import { EnforcementDecision, ThothConfig } from "./models";
type EnforceConfig = Required<Pick<ThothConfig, "agentId" | "approvedScope" | "tenantId" | "userId" | "enforcement" | "apiKey" | "apiUrl" | "stepUpTimeoutMinutes" | "stepUpPollIntervalMs" | "environment">> & Pick<ThothConfig, "sessionIntent" | "policyContext" | "enforcementTraceId"> & Pick<ThothConfig, "identityBinding">;
export declare function checkEnforce(config: EnforceConfig, toolName: string, sessionId: string, sessionToolCalls: string[], toolArgs?: Record<string, unknown>, enforcementTraceId?: string): Promise<EnforcementDecision>;
export declare function awaitStepUpDecision(config: EnforceConfig, holdToken: string): Promise<EnforcementDecision>;
export {};
//# sourceMappingURL=enforcer-client.d.ts.map