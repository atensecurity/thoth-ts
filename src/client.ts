import { wrapAnthropicTools, type AnthropicToolFn } from "./integrations/anthropic";
import { wrapOpenAITools, type OpenAIToolFn } from "./integrations/openai";
import { instrument } from "./instrumentor";
import type { ThothConfig } from "./models";

type ClientConfig = Partial<ThothConfig>;

/**
 * Backward-compatible facade for Thoth SDK usage.
 *
 * Prefer module-level APIs (`instrument`, `wrapAnthropicTools`,
 * `wrapOpenAITools`) for new integrations.
 */
export class ThothClient {
  private readonly defaults: ClientConfig;

  constructor(defaults: ClientConfig = {}) {
    this.defaults = defaults;
  }

  instrument<T extends object>(agent: T, config: ClientConfig = {}): T {
    return instrument(agent, this.merged(config));
  }

  instrumentAnthropic(
    toolFns: Record<string, AnthropicToolFn>,
    config: ClientConfig = {},
  ): Record<string, AnthropicToolFn> {
    return wrapAnthropicTools(toolFns, this.merged(config));
  }

  instrumentOpenAI(
    toolFns: Record<string, OpenAIToolFn>,
    config: ClientConfig = {},
  ): Record<string, OpenAIToolFn> {
    return wrapOpenAITools(toolFns, this.merged(config));
  }

  // Legacy aliases kept for backwards compatibility.
  wrap<T extends object>(agent: T, config: ClientConfig = {}): T {
    return this.instrument(agent, config);
  }

  wrapAnthropicTools(
    toolFns: Record<string, AnthropicToolFn>,
    config: ClientConfig = {},
  ): Record<string, AnthropicToolFn> {
    return this.instrumentAnthropic(toolFns, config);
  }

  wrapOpenAITools(
    toolFns: Record<string, OpenAIToolFn>,
    config: ClientConfig = {},
  ): Record<string, OpenAIToolFn> {
    return this.instrumentOpenAI(toolFns, config);
  }

  private merged(config: ClientConfig): ThothConfig {
    return {
      ...this.defaults,
      ...config,
    } as ThothConfig;
  }
}
