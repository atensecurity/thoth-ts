export { instrument } from "./instrumentor.js";
export { ThothClient } from "./client.js";
export { ThothPolicyViolation } from "./models.js";
export type {
  BehavioralEvent,
  ThothConfig,
  EnforcementDecision,
  HumanExplanation,
  ThothConfig as InstrumentOptions,
} from "./models.js";
export { EnforcementMode, DecisionType, SourceType, EventType } from "./models.js";

export { emitBehavioralEvent } from "./emitter.js";
export type { DeliveryOptions, DeliveryStatus } from "./emitter.js";

// Framework integrations — also available as sub-path imports:
//   import { wrapAnthropicTools } from "@atensec/thoth/anthropic"
//   import { wrapOpenAITools }    from "@atensec/thoth/openai"
export { wrapAnthropicTools } from "./integrations/anthropic.js";
export type { AnthropicToolFn } from "./integrations/anthropic.js";
export { wrapOpenAITools } from "./integrations/openai.js";
export type { OpenAIToolFn } from "./integrations/openai.js";
