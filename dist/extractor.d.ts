import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
export declare function extractFromConversation(config: SmartMemoryConfig, storage: Storage, messages: Array<{
    role: string;
    content: string;
}>, conversationId: string, opts?: {
    forceExtract?: boolean;
}): Promise<StoredChunk[]>;
/**
 * Keep only LLM candidates that cite at least one user message in this batch. Where a memory
 * comes from is decided by the messages it cites, never by what the model says about it: a
 * candidate citing nothing, a number outside the batch, or only assistant turns is dropped.
 * That is the cheap guard against a model inventing a memory or taking one from the assistant.
 */
export declare function keepCitedCandidates(raw: Array<Record<string, any>>, messages: Array<{
    role: string;
    content: string;
}>): Array<Record<string, any>>;
export declare function reconsolidate(config: SmartMemoryConfig, storage: Storage, chunk: StoredChunk, recentMessages: Array<{
    role: string;
    content: string;
}>): Promise<void>;
