import { wrapAnthropicTools } from "./integrations/anthropic";
import { wrapOpenAITools } from "./integrations/openai";
import { instrument } from "./instrumentor";
/**
 * Backward-compatible facade for Thoth SDK usage.
 *
 * Prefer module-level APIs (`instrument`, `wrapAnthropicTools`,
 * `wrapOpenAITools`) for new integrations.
 */
export class ThothClient {
    constructor(defaults = {}) {
        this.defaults = defaults;
    }
    instrument(agent, config = {}) {
        return instrument(agent, this.merged(config));
    }
    instrumentAnthropic(toolFns, config = {}) {
        return wrapAnthropicTools(toolFns, this.merged(config));
    }
    instrumentOpenAI(toolFns, config = {}) {
        return wrapOpenAITools(toolFns, this.merged(config));
    }
    // Legacy aliases kept for backwards compatibility.
    wrap(agent, config = {}) {
        return this.instrument(agent, config);
    }
    wrapAnthropicTools(toolFns, config = {}) {
        return this.instrumentAnthropic(toolFns, config);
    }
    wrapOpenAITools(toolFns, config = {}) {
        return this.instrumentOpenAI(toolFns, config);
    }
    merged(config) {
        return {
            ...this.defaults,
            ...config,
        };
    }
}
//# sourceMappingURL=client.js.map