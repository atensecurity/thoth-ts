export { instrument } from "./instrumentor";
export { ThothClient } from "./client";
export { ThothPolicyViolation } from "./models";
export type {
  BehavioralEvent,
  ThothConfig,
  EnforcementDecision,
  ThothConfig as InstrumentOptions,
} from "./models";
export { EnforcementMode, DecisionType, SourceType, EventType } from "./models";

export { emitBehavioralEvent } from "./emitter";

// Framework integrations — also available as sub-path imports:
//   import { wrapAnthropicTools } from "@atensec/thoth/anthropic"
//   import { wrapOpenAITools }    from "@atensec/thoth/openai"
export { wrapAnthropicTools } from "./integrations/anthropic";
export type { AnthropicToolFn } from "./integrations/anthropic";
export { wrapOpenAITools } from "./integrations/openai";
export type { OpenAIToolFn } from "./integrations/openai";
