import { memEnv, dirWithLegacyFallback } from './env.js';
import OpenAI from 'openai';
import { accessSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SmartMemoryConfig } from './types.js';
import { claudeCliComplete, claudeCliModel, usesClaudeCli } from './claude-cli.js';

/**
 * LLM provider for the MCP server.
 *
 * Completions: any OpenAI-compatible endpoint. OpenRouter by default
 *   (key in NOMAD_MEMORY_LLM_API_KEY or OPENROUTER_API_KEY); point
 *   NOMAD_MEMORY_LLM_BASE_URL (legacy ENGRAM_LLM_BASE_URL) at Ollama,
 *   LM Studio, vLLM, a provider's own OpenAI-compatible API or a proxy.
 *   Default model: anthropic/claude-haiku-4.5 (fast, cheap).
 *   Override with NOMAD_MEMORY_LLM_MODEL (legacy ENGRAM_MODEL).
 *   Or NOMAD_MEMORY_LLM_PROVIDER=claude-cli to use the Claude subscription signed in to the
 *   Claude Code CLI on this machine (see claude-cli.ts; model defaults to haiku).
 *
 * Embeddings: Local ONNX model via @huggingface/transformers.
 *   Default model: Xenova/bge-small-en-v1.5 (384-dim, ~34 MB, cached after first use).
 *   Override with NOMAD_MEMORY_EMBEDDING_MODEL env var (legacy: ENGRAM_EMBEDDING_MODEL).
 *   After changing the model, run `nomad-memory-mcp reembed` — stored vectors
 *   live in the old model's space and mixed-space search silently degrades.
 *
 * GPU acceleration:
 *   Set ENGRAM_DEVICE=dml   for AMD/Intel/NVIDIA DirectML (Windows)
 *   Set ENGRAM_DEVICE=cuda  for NVIDIA CUDA
 *   Set ENGRAM_DEVICE=cpu   for CPU only (default)
 */

// ── LLM Completions (OpenRouter) ────────────────────────────────────

let _client: OpenAI | null = null;

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Where completions go and with what key, or null when no LLM is configured. A custom base URL
 * needs no key: local servers usually don't check one, but the OpenAI SDK insists on a value.
 */
function resolveLlmEndpoint(): { baseURL: string; apiKey: string } | null {
  const baseURL = memEnv('LLM_BASE_URL', ['ENGRAM_LLM_BASE_URL']) ?? OPENROUTER_BASE_URL;
  const apiKey = memEnv('LLM_API_KEY')
    ?? process.env.OPENROUTER_API_KEY
    ?? (baseURL !== OPENROUTER_BASE_URL ? 'local' : undefined);
  return apiKey ? { baseURL, apiKey } : null;
}

function getClient(): OpenAI | null {
  if (_client) return _client;
  const endpoint = resolveLlmEndpoint();
  if (!endpoint) return null;
  _client = new OpenAI(endpoint);
  return _client;
}

export function isLlmAvailable(): boolean {
  return usesClaudeCli() || resolveLlmEndpoint() !== null;
}

export function getLlmModelName(): string {
  if (usesClaudeCli()) return claudeCliModel();
  return memEnv('LLM_MODEL', ['ENGRAM_MODEL', 'SMART_MEMORY_MODEL'])
    ?? 'anthropic/claude-haiku-4.5';
}

export async function llmComplete(
  _config: SmartMemoryConfig,
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  // The CLI has no max-tokens or temperature setting; its replies here are short JSON anyway.
  if (usesClaudeCli()) return claudeCliComplete(systemPrompt, userMessage);
  const client = getClient();
  if (!client) {
    throw new Error(
      'No LLM configured for LLM-powered features (extraction, re-ranking, procedural rules). ' +
      'Set NOMAD_MEMORY_LLM_BASE_URL to any OpenAI-compatible endpoint (a local Ollama needs no key), ' +
      'NOMAD_MEMORY_LLM_API_KEY / OPENROUTER_API_KEY for OpenRouter, ' +
      'or NOMAD_MEMORY_LLM_PROVIDER=claude-cli to use your Claude subscription through Claude Code.'
    );
  }

  const response = await client.chat.completions.create({
    model: getLlmModelName(),
    max_tokens: opts?.maxTokens ?? 1000,
    temperature: opts?.temperature ?? 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? '';
}

// ── Local Embeddings ────────────────────────────────────────────────

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
/** Default before v1.1 — stores created back then hold vectors in this model's space. */
export const LEGACY_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export function getEmbeddingModelName(): string {
  return memEnv('EMBEDDING_MODEL', ['ENGRAM_EMBEDDING_MODEL', 'SMART_MEMORY_EMBEDDING_MODEL'])
    ?? DEFAULT_EMBEDDING_MODEL;
}

/**
 * Model-family retrieval profile. Cosine-similarity distributions differ
 * by model family: MiniLM-class models put unrelated pairs near 0.1-0.3,
 * BGE v1.5 compresses everything into a higher band (unrelated pairs sit
 * around 0.5-0.65). Floors and duplicate thresholds must shift with the
 * model or they either pass everything or block everything.
 *
 * BGE v1.5 is also asymmetric: short queries need the instruction prefix
 * the model was trained with; passages embed bare. MiniLM is symmetric,
 * where the lightweight 'search query: ' prefix only applies when
 * contextual prefixes are enabled (the space its floor was calibrated in).
 */
export interface EmbeddingModelProfile {
  /** Instruction prepended to query-side embeds. */
  queryPrefix: string;
  /** True when the model requires the query prefix regardless of the contextual-prefix flag. */
  alwaysPrefixQuery: boolean;
  /** Vector-stage similarity floor for standard queries. */
  similarityFloor: number;
  /** Floor for preference/recommendation queries (embed far from concrete content). */
  preferenceFloor: number;
  /** Floor for aggregation queries (answer needs N chunks, not one match). */
  aggregationFloor: number;
  /** Ingest dedupe: cosine similarity above which content counts as a near-duplicate. */
  dupCheck: number;
  /** Dedupe recommendation ladder: reinforce-existing threshold. */
  dupReinforce: number;
  /** Dedupe recommendation ladder: accept-existing threshold. */
  dupAccept: number;
  /** Small int stamped on chunks as embeddingVersion (1=MiniLM-384, 2=nomic-256, 3=bge-small-384). */
  version: number;
}

export function getEmbeddingModelProfile(modelName?: string): EmbeddingModelProfile {
  const name = (modelName ?? getEmbeddingModelName()).toLowerCase();
  if (name.includes('bge-')) {
    // Floor calibration note: the synthetic alien-query corpus (short
    // clean sentences) puts BGE on-topic sims at 0.72+, but real stored
    // memories are long, multi-clause, and carry heavy contextual
    // prefixes — live relevant hits land at ~0.46-0.55. The floor sits
    // below the live relevance band and cuts only the bottom of the
    // noise distribution (~0.37+), same positioning the 0.25 MiniLM
    // floor had relative to its 0.45 noise ceiling.
    return {
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      alwaysPrefixQuery: true,
      similarityFloor: 0.42,
      preferenceFloor: 0.35,
      aggregationFloor: 0.38,
      dupCheck: 0.85,
      dupReinforce: 0.9,
      dupAccept: 0.95,
      version: 3,
    };
  }
  if (name.includes('nomic')) {
    return {
      queryPrefix: 'search_query: ',
      alwaysPrefixQuery: true,
      similarityFloor: 0.4,
      preferenceFloor: 0.3,
      aggregationFloor: 0.33,
      dupCheck: 0.8,
      dupReinforce: 0.85,
      dupAccept: 0.92,
      version: 2,
    };
  }
  // MiniLM-class symmetric models (the pre-v1.1 default).
  return {
    queryPrefix: 'search query: ',
    alwaysPrefixQuery: false,
    similarityFloor: 0.25,
    preferenceFloor: 0.15,
    aggregationFloor: 0.18,
    dupCheck: 0.75,
    dupReinforce: 0.8,
    dupAccept: 0.9,
    version: 1,
  };
}

// The transformers.js pipeline returns a callable feature-extraction
// function. The library's TS types are messy so we keep `unknown` here
// and narrow at the call site (only `embed()` calls it). Avoids `any`
// in load-bearing module state.
type ExtractorFn = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;

let _extractor: ExtractorFn | null = null;
let _extractorLoading: Promise<ExtractorFn> | null = null;

function getDevice(): string {
  return process.env.ENGRAM_DEVICE ?? process.env.SMART_MEMORY_DEVICE ?? 'cpu';
}

/**
 * Per-file progress reporter for the first-call HuggingFace download.
 *
 * The model download is ~23MB on first install and can take 10-30s on
 * slow connections. Without progress feedback an MCP client sees the
 * tool call as frozen and the user thinks the install is broken. We
 * log at 25/50/75/100% thresholds per file -- enough liveness signal
 * to stay calm, not enough to spam.
 *
 * `status === 'done'` fires both for completed downloads AND for files
 * that were already cached (no actual download). We use it to
 * differentiate the two cases in the user-visible log.
 */
function makeProgressReporter(): (progress: unknown) => void {
  const announced = new Map<string, Set<number>>();
  return (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as { status?: string; file?: string; progress?: number; total?: number };
    if (!p.file) return;
    if (p.status === 'progress' && typeof p.progress === 'number') {
      const pct = Math.floor(p.progress);
      for (const threshold of [25, 50, 75, 100]) {
        if (pct >= threshold) {
          let seen = announced.get(p.file);
          if (!seen) {
            seen = new Set();
            announced.set(p.file, seen);
          }
          if (!seen.has(threshold)) {
            seen.add(threshold);
            const mb = p.total ? ` (${(p.total / 1_000_000).toFixed(1)}MB)` : '';
            console.error(`nomad-memory: downloading ${p.file}${mb} — ${threshold}%`);
          }
        }
      }
    } else if (p.status === 'done' && !announced.has(p.file)) {
      // Cached-file path: progress events never fired, just a 'done'.
      console.error(`nomad-memory: ${p.file} (cached)`);
    }
  };
}

/**
 * Where the embedding model is cached. `NOMAD_MEMORY_MODEL_DIR` wins. Otherwise the library's
 * default (inside node_modules) is kept while it is writable, so an existing cache keeps
 * working; a global or npx install often can't write there, and the download then fails or
 * stalls, so it falls back to ~/.cache/nomad-memory/models.
 */
export function resolveModelCacheDir(libraryDefault: string): string {
  const override = memEnv('MODEL_DIR');
  if (override) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  try {
    mkdirSync(libraryDefault, { recursive: true });
    accessSync(libraryDefault, fsConstants.W_OK);
    return libraryDefault;
  } catch {
    const fallback = dirWithLegacyFallback(join(homedir(), '.cache'), 'models');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

async function getExtractor(): Promise<ExtractorFn> {
  if (_extractor) return _extractor;

  if (!_extractorLoading) {
    _extractorLoading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      const modelName = getEmbeddingModelName();
      const device = getDevice();
      if (env.cacheDir) env.cacheDir = resolveModelCacheDir(env.cacheDir);
      console.error(`nomad-memory: loading embedding model ${modelName} (device: ${device})...`);
      console.error(`nomad-memory: first-time setup downloads the model once, then caches at ${env.cacheDir}`);
      const progress_callback = makeProgressReporter();
      const loaded = await pipeline('feature-extraction', modelName, { device, progress_callback } as never);
      _extractor = loaded as unknown as ExtractorFn;
      console.error('nomad-memory: embedding model ready');
      return _extractor;
    })();
  }

  return _extractorLoading;
}

/**
 * Trigger the embedding model load in the background so the user's
 * first search query doesn't pay the ~1.5–5s ONNX pipeline-construction
 * cost (or worse: the 10–30s first-time download).
 *
 * Idempotent: shares the same `_extractorLoading` promise as the lazy
 * `getExtractor()` path. Calling this twice does not double-load.
 *
 * No-op when `ENGRAM_SKIP_EMBED=1` is set — callers in that mode have
 * already opted out of embeddings entirely, so eager loading would
 * waste memory and CPU.
 *
 * Returns the loading promise so callers can `await` if they want
 * synchronous readiness; the typical server-boot caller does
 * `void warmEmbeddings()` and lets it run while the MCP handshake
 * settles.
 */
export function warmEmbeddings(): Promise<void> {
  if (process.env.ENGRAM_SKIP_EMBED === '1') return Promise.resolve();
  console.error('nomad-memory: pre-warming embedding model in background (first query will not pay the cold-start cost)');
  return getExtractor().then(
    () => undefined,
    (err) => {
      // Don't crash the server — embeddings can fail to load on systems
      // without the runtime deps installed. Subsequent embed() calls
      // will hit the same error and fall through to keyword-only mode.
      console.error('nomad-memory: background embedding warmup failed (continuing without):', err);
    },
  );
}

export async function embed(
  config: SmartMemoryConfig,
  text: string,
  contextPrefix?: string
): Promise<number[]> {
  // Hard kill-switch for callers that need to skip the ~1.5s model load
  // (e.g. CLI hooks running on every UserPromptSubmit). Throwing here lets
  // search.ts fall into its existing keyword-only fallback path.
  if (process.env.ENGRAM_SKIP_EMBED === '1') {
    throw new Error('ENGRAM_SKIP_EMBED=1');
  }
  try {
    const extractor = await getExtractor();
    // Contextual prefix improves retrieval by 35-49% (Anthropic research)
    const inputText = (config.enableContextualPrefix && contextPrefix)
      ? contextPrefix + text
      : text;
    const output = await extractor(inputText, { pooling: 'mean', normalize: true });
    const full = Array.from(output.data as Float32Array);

    // Matryoshka truncation: slice to configured dimensions and re-normalize
    if (config.embeddingDimensions > 0 && config.embeddingDimensions < full.length) {
      const truncated = full.slice(0, config.embeddingDimensions);
      const norm = Math.sqrt(truncated.reduce((s, v) => s + v * v, 0));
      if (norm > 0) return truncated.map(v => v / norm);
      return truncated;
    }

    return full;
  } catch (err) {
    console.error('nomad-memory: embedding failed, falling back to keyword-only:', err);
    return [];
  }
}
