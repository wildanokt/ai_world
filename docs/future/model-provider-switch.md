# Future plan: switch or add LLM providers

Not scheduled. The project may later use models from providers other than Anthropic.

## Prerequisites (do now, cheap)

- All LLM calls go through one `ModelProvider` interface (chat with streaming, tool calls, token usage). No SDK imports outside the provider implementations.
- Define tools (`roll_dice`, `give_item`, `recall`, ...) in a provider-neutral schema (JSON Schema), and convert to each provider's format inside its adapter.
- Model routing (cheap vs strong) refers to abstract tiers (`fast`, `strong`), mapped to concrete models per provider in config.
- Store token usage and cost in a provider-neutral shape so the cost counter keeps working.
- Embeddings and image generation already sit behind their own swappable interfaces.

## Things to verify per new provider

- Tool-use reliability (the game depends on valid tool calls; ADR 0002).
- Streaming format and cancellation.
- Prompt caching support, since the long World and rules context is expensive without it.
- Context window size versus the summary and Recall budget.
- Language quality for Indonesian and English narration.
- Content policy differences versus the World's tone setting.

## Migration outline

1. Implement the new provider adapter behind `ModelProvider`.
2. Run the same fake-model and recorded-turn tests against it.
3. Add provider and tier-to-model mapping to the God Console AI settings.
4. Compare narration and tool-call quality on a saved Campaign before making it the default.
