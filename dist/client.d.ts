import { type AnthropicToolFn } from "./integrations/anthropic";
import { type OpenAIToolFn } from "./integrations/openai";
import type { ThothConfig } from "./models";
type ClientConfig = Partial<ThothConfig>;
/**
 * Backward-compatible facade for Thoth SDK usage.
 *
 * Prefer module-level APIs (`instrument`, `wrapAnthropicTools`,
 * `wrapOpenAITools`) for new integrations.
 */
export declare class ThothClient {
    private readonly defaults;
    constructor(defaults?: ClientConfig);
    instrument<T extends object>(agent: T, config?: ClientConfig): T;
    instrumentAnthropic(toolFns: Record<string, AnthropicToolFn>, config?: ClientConfig): Record<string, AnthropicToolFn>;
    instrumentOpenAI(toolFns: Record<string, OpenAIToolFn>, config?: ClientConfig): Record<string, OpenAIToolFn>;
    wrap<T extends object>(agent: T, config?: ClientConfig): T;
    wrapAnthropicTools(toolFns: Record<string, AnthropicToolFn>, config?: ClientConfig): Record<string, AnthropicToolFn>;
    wrapOpenAITools(toolFns: Record<string, OpenAIToolFn>, config?: ClientConfig): Record<string, OpenAIToolFn>;
    private merged;
}
export {};
//# sourceMappingURL=client.d.ts.map