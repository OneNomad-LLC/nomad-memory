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
export interface RerankResult {
    index: number;
    score: number;
}
/**
 * Rerank documents against a query using a cross-encoder.
 * Returns sorted results with scores (the model's relevance logit), highest first.
 */
export declare function rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]>;
/**
 * Check if the reranker model is available (already downloaded).
 * Does not trigger download.
 */
export declare function isRerankerAvailable(): boolean;
