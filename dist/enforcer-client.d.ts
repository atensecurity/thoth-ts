import { EnforcementDecision, ThothConfig } from "./models";
type EnforceConfig = Required<Pick<ThothConfig, "agentId" | "approvedScope" | "tenantId" | "userId" | "enforcement" | "apiKey" | "apiUrl" | "stepUpTimeoutMinutes" | "stepUpPollIntervalMs" | "environment" | "failOpen">> & Pick<ThothConfig, "sessionIntent" | "policyContext" | "enforcementTraceId" | "purpose" | "dataClassification" | "taskContext"> & Pick<ThothConfig, "identityBinding">;
export declare function checkEnforce(config: EnforceConfig, toolName: string, sessionId: string, sessionToolCalls: string[], toolArgs?: Record<string, unknown>, enforcementTraceId?: string): Promise<EnforcementDecision>;
export declare function awaitStepUpDecision(config: EnforceConfig, holdToken: string): Promise<EnforcementDecision>;
export {};
//# sourceMappingURL=enforcer-client.d.ts.map