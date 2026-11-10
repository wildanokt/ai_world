/** Turns text into vectors for semantic Recall. Swappable, like the model provider. */
export interface Embedder {
  /** Identifies the vector space; vectors from different models are never mixed. */
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** OpenAI embeddings (text-embedding-3-small by default). Needs OPENAI_API_KEY. */
export function createOpenAIEmbedder({
  apiKey,
  model = "text-embedding-3-small",
  dimensions = 1536,
}: {
  apiKey: string;
  model?: string;
  dimensions?: number;
}): Embedder {
  return {
    model,
    dimensions,
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts, dimensions }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text().catch(() => "")}`);
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    },
  };
}
