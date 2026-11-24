/**
 * Cross-encoder reranking using @huggingface/transformers.
 *
 * A small cross-encoder (ONNX, CPU) reads the query and one document together and scores how
 * well the document answers the query, which a bi-encoder's vector similarity can only
 * approximate.
 *
 * Default model: Xenova/ms-marco-MiniLM-L-6-v2
 * Override: NOMAD_MEMORY_RERANK_MODEL (ENGRAM_RERANK_MODEL still read)
 *
 * Lazy-loaded on first call (same pattern as the embedding model).
 */

import { memEnv } from './env.js';

export interface RerankResult {
  index: number;
  score: number;
}

interface CrossEncoder {
  tokenizer: (queries: string[], opts: Record<string, unknown>) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array } }>;
}

/** Pairs scored per forward pass; padding to the longest pair makes bigger batches slower, not faster. */
const BATCH = 16;
/** The model reads 512 tokens of query plus document; anything longer is cut off. */
const MAX_TOKENS = 512;

let _reranker: CrossEncoder | null = null;
let _rerankerLoading: Promise<CrossEncoder> | null = null;

async function getReranker(): Promise<CrossEncoder> {
  if (_reranker) return _reranker;

  if (!_rerankerLoading) {
    _rerankerLoading = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
      const modelName = memEnv('RERANK_MODEL', ['ENGRAM_RERANK_MODEL', 'SMART_MEMORY_RERANK_MODEL']) ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
      const device = process.env.ENGRAM_DEVICE ?? process.env.SMART_MEMORY_DEVICE ?? 'cpu';
      console.error(`nomad-memory: loading reranker model ${modelName} (device: ${device})...`);
      const tokenizer = await AutoTokenizer.from_pretrained(modelName);
      const model = await AutoModelForSequenceClassification.from_pretrained(modelName, { device } as never);
      console.error('nomad-memory: reranker model ready');
      _reranker = { tokenizer, model } as unknown as CrossEncoder;
      return _reranker;
    })();
    // A failed load (no network on first use) must not poison every later call.
    _rerankerLoading.catch(() => { _rerankerLoading = null; });
  }

  return _rerankerLoading;
}

/**
 * Rerank documents against a query using a cross-encoder.
 * Returns sorted results with scores (the model's relevance logit), highest first.
 */
export async function rerank(
  query: string,
  documents: string[],
  topK: number = 10
): Promise<RerankResult[]> {
  const { tokenizer, model } = await getReranker();

  const results: RerankResult[] = [];
  for (let start = 0; start < documents.length; start += BATCH) {
    const batch = documents.slice(start, start + BATCH);
    const inputs = tokenizer(batch.map(() => query), {
      text_pair: batch, padding: true, truncation: true, max_length: MAX_TOKENS,
    });
    const { logits } = await model(inputs);
    batch.forEach((_, i) => results.push({ index: start + i, score: logits.data[i] }));
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Check if the reranker model is available (already downloaded).
 * Does not trigger download.
 */
export function isRerankerAvailable(): boolean {
  return _reranker !== null;
}
