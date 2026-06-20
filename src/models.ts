export enum EnforcementMode {
  OBSERVE = "observe",
  STEP_UP = "step_up",
  BLOCK = "block",
  PROGRESSIVE = "progressive",
}

export enum SourceType {
  AGENT_TOOL_CALL = "agent_tool_call",
  AGENT_LLM_INVOCATION = "agent_llm_invocation",
}

export enum EventType {
  TOOL_CALL_PRE = "TOOL_CALL_PRE",
  TOOL_CALL_POST = "TOOL_CALL_POST",
  TOOL_CALL_BLOCK = "TOOL_CALL_BLOCK",
  LLM_INVOCATION = "LLM_INVOCATION",
}

export enum DecisionType {
  ALLOW = "ALLOW",
  BLOCK = "BLOCK",
  STEP_UP = "STEP_UP",
  MODIFY = "MODIFY",
  DEFER = "DEFER",
}

export interface BehavioralEvent {
  eventId: string;
  tenantId: string;
  agentId?: string;
  sessionId: string;
  purpose?: string;
  dataClassification?: string;
  taskContext?: Record<string, unknown>;
  initiatedBy?: string;
  taskId?: string;
  delegationChain?: string[];
  toolName?: string;
  violationId?: string;
  userId: string;
  sourceType: SourceType;
  eventType: EventType;
  content: string;
  metadata?: Record<string, unknown>;
  approvedScope: string[];
  enforcementMode: EnforcementMode;
  sessionToolCalls: string[];
  occurredAt: Date;
}

export interface ThothConfig {
  agentId: string;
  approvedScope: string[];
  tenantId: string;
  userId?: string;
  enforcement?: EnforcementMode;
  apiKey?: string;
  /**
   * Tenant API base URL used for both behavioral event ingestion and policy checks.
   * Required directly or through THOTH_API_URL. Example:
   * https://enforce.<tenant>.<apex-domain>
   */
  apiUrl?: string;
  stepUpTimeoutMinutes?: number;
  stepUpPollIntervalMs?: number;
  /**
   * Declares the purpose of this session for HIPAA minimum-necessary enforcement.
   * When the active compliance pack defines session_scopes, tools outside the
   * declared intent scope are step-up-challenged even if they appear in approvedScope.
   * Example: "phi_eligibility_check"
   */
  sessionIntent?: string;
  /**
   * Optional tenant-defined policy context sent to the enforcer as
   * metadata.policy_context for tenant/role-aware pre-filters.
   */
  policyContext?: Record<string, unknown>;
  /**
   * Optional identity binding context for execution-time actor verification.
   * When omitted, the SDK sends a default binding with agent_id, tenant_id,
   * and user_id (when available).
   */
  identityBinding?: Record<string, unknown>;
  /**
   * Optional correlation identifier propagated through enforcer -> fastml -> deepllm.
   * Defaults to the instrumented session UUID when omitted.
   */
  enforcementTraceId?: string;
  /**
   * Optional purpose context for purpose/sensitivity governance.
   */
  purpose?: string;
  /**
   * Optional data sensitivity label for purpose/sensitivity governance.
   */
  dataClassification?: string;
  /**
   * Optional task/delegation context (initiatedBy, taskId, chain).
   */
  taskContext?: Record<string, unknown>;
  /**
   * Environment tag used for env-scoped policy resolution ("dev", "prod", ...).
   * Defaults to "prod".
   */
  environment?: string;
  /**
   * When true, transport/availability failures from the enforcer (timeouts,
   * 429, 5xx) return ALLOW so workloads continue.
   */
  failOpen?: boolean;
}

export interface EnforcementDecision {
  decision: DecisionType;
  authorizationDecision?: string;
  decisionReasonCode?: string;
  actionClassification?: string;
  reason?: string;
  violationId?: string;
  holdToken?: string;
  riskScore?: number;
  latencyMs?: number;
  packId?: string;
  packVersion?: string;
  ruleVersion?: number;
  regulatoryRegimes?: string[];
  matchedRuleIds?: string[];
  matchedControlIds?: string[];
  policyReferences?: string[];
  modelSignals?: string[];
  receipt?: Record<string, unknown>;
  modifiedToolArgs?: Record<string, unknown>;
  modificationReason?: string;
  deferReason?: string;
  deferTimeoutSeconds?: number;
  stepUpTimeoutSeconds?: number;
  decisionEnvelopeVersion?: string;
  enforcementTraceId?: string;
  fastmlFeatures?: Record<string, number>;
  scoreComponents?: Record<string, unknown>;
  topContributors?: Record<string, unknown>[];
  decisionEvidence?: Record<string, unknown>;
}

export class ThothPolicyViolation extends Error {
  public readonly decisionReasonCode?: string;
  public readonly actionClassification?: string;
  public readonly authorizationDecision?: string;
  public readonly deferTimeoutSeconds?: number;
  public readonly stepUpTimeoutSeconds?: number;
  public readonly riskScore?: number;
  public readonly latencyMs?: number;
  public readonly packId?: string;
  public readonly packVersion?: string;
  public readonly ruleVersion?: number;
  public readonly regulatoryRegimes?: string[];
  public readonly matchedRuleIds?: string[];
  public readonly matchedControlIds?: string[];
  public readonly policyReferences?: string[];
  public readonly modelSignals?: string[];
  public readonly receipt?: Record<string, unknown>;

  public readonly decisionEnvelopeVersion?: string;
  public readonly enforcementTraceId?: string;
  public readonly fastmlFeatures?: Record<string, number>;
  public readonly scoreComponents?: Record<string, unknown>;
  public readonly topContributors?: Record<string, unknown>[];
  public readonly decisionEvidence?: Record<string, unknown>;

  constructor(
    public readonly toolName: string,
    public readonly reason: string,
    public readonly violationId?: string,
    options: {
      decisionReasonCode?: string;
      actionClassification?: string;
      authorizationDecision?: string;
      deferTimeoutSeconds?: number;
      stepUpTimeoutSeconds?: number;
      riskScore?: number;
      latencyMs?: number;
      packId?: string;
      packVersion?: string;
      ruleVersion?: number;
      regulatoryRegimes?: string[];
      matchedRuleIds?: string[];
      matchedControlIds?: string[];
      policyReferences?: string[];
      modelSignals?: string[];
      receipt?: Record<string, unknown>;
      decisionEnvelopeVersion?: string;
      enforcementTraceId?: string;
      fastmlFeatures?: Record<string, number>;
      scoreComponents?: Record<string, unknown>;
      topContributors?: Record<string, unknown>[];
      decisionEvidence?: Record<string, unknown>;
    } = {},
  ) {
    super(`Thoth blocked tool '${toolName}': ${reason}`);
    this.name = "ThothPolicyViolation";
    this.decisionReasonCode = options.decisionReasonCode;
    this.actionClassification = options.actionClassification;
    this.authorizationDecision = options.authorizationDecision;
    this.deferTimeoutSeconds = options.deferTimeoutSeconds;
    this.stepUpTimeoutSeconds = options.stepUpTimeoutSeconds;
    this.riskScore = options.riskScore;
    this.latencyMs = options.latencyMs;
    this.packId = options.packId;
    this.packVersion = options.packVersion;
    this.ruleVersion = options.ruleVersion;
    this.regulatoryRegimes = options.regulatoryRegimes;
    this.matchedRuleIds = options.matchedRuleIds;
    this.matchedControlIds = options.matchedControlIds;
    this.policyReferences = options.policyReferences;
    this.modelSignals = options.modelSignals;
    this.receipt = options.receipt;
    this.decisionEnvelopeVersion = options.decisionEnvelopeVersion;
    this.enforcementTraceId = options.enforcementTraceId;
    this.fastmlFeatures = options.fastmlFeatures;
    this.scoreComponents = options.scoreComponents;
    this.topContributors = options.topContributors;
    this.decisionEvidence = options.decisionEvidence;
  }
}
