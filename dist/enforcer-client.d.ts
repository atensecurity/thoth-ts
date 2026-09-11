import { EnforcementDecision, HumanExplanation, ThothConfig } from "./models.js";
type EnforceConfig = Required<Pick<ThothConfig, "agentId" | "approvedScope" | "tenantId" | "userId" | "enforcement" | "apiKey" | "apiUrl" | "stepUpTimeoutMinutes" | "stepUpPollIntervalMs" | "environment" | "failOpen">> & Pick<ThothConfig, "sessionIntent" | "policyContext" | "enforcementTraceId" | "actionAttestationId" | "purpose" | "dataClassification" | "taskContext"> & Pick<ThothConfig, "identityBinding">;
export declare function checkEnforce(config: EnforceConfig, toolName: string, sessionId: string, sessionToolCalls: string[], toolArgs?: Record<string, unknown>, enforcementTraceId?: string, actionAttestationId?: string): Promise<EnforcementDecision>;
export declare function requestHumanExplanation(config: EnforceConfig, decision: EnforcementDecision, toolName: string, sessionId: string, sessionToolCalls: string[], toolArgs?: Record<string, unknown>, actionAttestationId?: string): Promise<HumanExplanation | undefined>;
export declare function awaitStepUpDecision(config: EnforceConfig, holdToken: string): Promise<EnforcementDecision>;
export {};
//# sourceMappingURL=enforcer-client.d.ts.map