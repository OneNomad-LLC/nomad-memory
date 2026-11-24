/**
 * Shared retrieval engine for the memory benchmarks (LongMemEval, BEAM, MemoryAgentBench).
 *
 * A benchmark hands over a corpus (items, each with a `source` id) and queries (each with the
 * relevant source ids, or gold answer strings when the dataset has no evidence labels). The
 * engine stores the corpus in a fresh local store, runs nomad-memory's `search()` for every
 * query, and scores what came back. It measures write latency (embed plus an amortised share
 * of the batched store write, per item), read latency (one `search()`), and the tokens of the
 * retrieved context a model would have to read.
 *
 * This measures retrieval only. It says nothing about answer accuracy; see qa.ts for that.
 */

import { mkdirSync } from 'node:fs';
import { rm as fsRm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage, type StoredChunk } from '../../src/storage.js';
import { loadConfig } from '../../src/config.js';
import { getEmbeddingModelName } from '../../src/llm.js';
import { cachedEmbed, embedCacheDir } from './embed-cache.js';
import { buildContextPrefix, estimateTokens } from '../../src/utils.js';
import { search } from '../../src/search.js';
import { chunkContent } from '../../src/chunker.js';
import type { SmartMemoryConfig } from '../../src/types.js';
import { percentiles, writeBenchmarkResult } from './results.js';

export interface CorpusItem {
  source: string;
  text: string;
  /** When the item happened; feeds the contextual prefix and the temporal stages. */
  createdAt?: string;
}

export interface RetrievalQuery {
  id: string;
  type: string;
  text: string;
  /** Source ids that hold the evidence. Scored with recall and NDCG. */
  relevant?: string[];
  /** Gold answers, for datasets without evidence labels. Scored by answer containment. */
  answers?: string[];
  /** "Now" for relative dates in the query (the dataset's timeline, not today). */
  referenceDate?: number;
}

export interface QueryOutcome {
  id: string;
  type: string;
  retrieved: string[];
  readMs: number;
  contextTokens: number;
  recallAny5?: number;
  recallAny10?: number;
  recallAll5?: number;
  recallAll10?: number;
  ndcg10?: number;
  answerHit5?: number;
  answerHit10?: number;
  /** Retrieved texts, best first, when asked for (QA needs them). */
  texts?: string[];
}

export const TOP_K = 10;
/** Characters of an item that get embedded; bge-small reads at most 512 tokens anyway. */
export const EMBED_CHARS = 2000;
const SAVE_BATCH = 256;
/**
 * `whole` (default): one stored item per corpus item, its first EMBED_CHARS characters embedded.
 * `chunked` (`--ingest chunked`): long items are split the way memory-ingest splits them.
 */
export const INGEST: 'whole' | 'chunked' = arg('ingest') === 'chunked' ? 'chunked' : 'whole';

export const dedupe = (ids: string[]): string[] => [...new Set(ids)];

export function recallAny(retrieved: string[], relevant: string[], k: number): number {
  const top = new Set(retrieved.slice(0, k));
  return relevant.some(id => top.has(id)) ? 1 : 0;
}

export function recallAll(retrieved: string[], relevant: string[], k: number): number {
  const top = new Set(retrieved.slice(0, k));
  return relevant.length > 0 && relevant.every(id => top.has(id)) ? 1 : 0;
}

/** Binary-relevance NDCG over a deduplicated ranking. */
export function ndcg(retrieved: string[], relevant: string[], k: number): number {
  const rel = new Set(relevant);
  let dcg = 0;
  retrieved.slice(0, k).forEach((id, i) => { if (rel.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(rel.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function answerHit(texts: string[], answers: string[], k: number): number {
  const golds = answers.map(normalise).filter(a => a.length > 0);
  const top = texts.slice(0, k).map(normalise);
  return top.some(t => golds.some(a => t.includes(a))) ? 1 : 0;
}

export function benchConfig(dataDir: string): SmartMemoryConfig {
  return { ...loadConfig({ dataDir }), dataDir, maxRecallChunks: TOP_K, maxRecallTokens: 1_000_000 };
}

/**
 * Store a corpus in a fresh temporary store, run every query, score it, and remove the store.
 * Write latency per item = its embedding time + its share of the batched store write.
 */
export async function evaluateCorpus(
  items: CorpusItem[],
  queries: RetrievalQuery[],
  opts: { keepTexts?: boolean; label?: string } = {},
): Promise<{ outcomes: QueryOutcome[]; writeMs: number[] }> {
  // Let fire-and-forget writes from the previous corpus drain before LanceDB opens again.
  await new Promise(resolve => setImmediate(resolve));
  const dir = join(tmpdir(), `nomad-bench-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const config = benchConfig(dir);
  const storage = new Storage(dir);
  await storage.ensureReady();

  const textBySource = new Map<string, string>();
  const writeMs: number[] = [];
  let pending: StoredChunk[] = [];
  let pendingEmbedMs: number[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const t = performance.now();
    await storage.saveChunks(pending);
    const share = (performance.now() - t) / Math.max(pendingEmbedMs.length, 1);
    for (const ms of pendingEmbedMs) writeMs.push(ms + share);
    pending = [];
    pendingEmbedMs = [];
  };

  for (const item of items) {
    if (item.text.trim().length === 0) continue;
    textBySource.set(item.source, item.text);
    const createdAt = item.createdAt || new Date(0).toISOString();
    const t = performance.now();
    const prefix = buildContextPrefix({ type: 'context', cognitiveLayer: 'episodic', createdAt });
    const base = {
      tier: 'long-term' as const, type: 'context' as const, cognitiveLayer: 'episodic' as const, tags: [], domain: '', topic: '',
      source: item.source, importance: 0.5, sentiment: 'neutral' as const, createdAt, lastRecalledAt: null, recallCount: 0,
      relatedMemories: [], recallOutcomes: [],
    };
    const split = INGEST === 'chunked' ? chunkContent(item.text) : { chunks: [item.text], needsSplit: false };
    if (split.needsSplit) {
      // What memory-ingest does with long content: the whole text as a parent without a
      // vector, and each piece as a child with one.
      const parentId = randomUUID();
      pending.push({ ...base, id: parentId, content: item.text, consolidationLevel: -1 });
      for (const piece of split.chunks) {
        const embedding = await cachedEmbed(config, piece, prefix);
        pending.push({ ...base, id: randomUUID(), content: piece, parentChunkId: parentId, embedding: embedding.length > 0 ? embedding : undefined });
      }
    } else {
      const embedding = await cachedEmbed(config, item.text.slice(0, EMBED_CHARS), prefix);
      pending.push({ ...base, id: randomUUID(), content: item.text, embedding: embedding.length > 0 ? embedding : undefined });
    }
    pendingEmbedMs.push(performance.now() - t);
    if (pending.length >= SAVE_BATCH) await flush();
  }
  await flush();

  const outcomes: QueryOutcome[] = [];
  for (const q of queries) {
    const t = performance.now();
    let results: Awaited<ReturnType<typeof search>>;
    try {
      results = await Promise.race([
        search(config, storage, q.text, TOP_K, q.referenceDate ? { referenceDate: q.referenceDate } : undefined),
        // unref: a pending timeout must not keep the process alive after the last search.
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('search timeout')), 60_000).unref()),
      ]);
    } catch (err) {
      console.error(`  [search failed] ${opts.label ?? ''} ${q.id}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const readMs = performance.now() - t;
    const retrieved = dedupe(results.map(r => r.chunk.source));
    const texts = retrieved.map(s => textBySource.get(s) ?? '');
    const outcome: QueryOutcome = {
      id: q.id, type: q.type, retrieved: retrieved.slice(0, TOP_K), readMs,
      contextTokens: results.reduce((n, r) => n + estimateTokens(r.chunk.content), 0),
    };
    if (q.relevant && q.relevant.length > 0) {
      outcome.recallAny5 = recallAny(retrieved, q.relevant, 5);
      outcome.recallAny10 = recallAny(retrieved, q.relevant, 10);
      outcome.recallAll5 = recallAll(retrieved, q.relevant, 5);
      outcome.recallAll10 = recallAll(retrieved, q.relevant, 10);
      outcome.ndcg10 = ndcg(retrieved, q.relevant, 10);
    }
    if (q.answers && q.answers.length > 0) {
      outcome.answerHit5 = answerHit(texts, q.answers, 5);
      outcome.answerHit10 = answerHit(texts, q.answers, 10);
    }
    if (opts.keepTexts) outcome.texts = texts;
    outcomes.push(outcome);
  }

  // LanceDB on Windows can hold handles for a while after use; remove the store in the
  // background rather than wait on it, and leave it to the OS if it still refuses.
  void fsRm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1_000 }).catch(() => undefined);
  return { outcomes, writeMs };
}

// ── Aggregation ──────────────────────────────────────────────────────

const METRICS = ['recallAll5', 'recallAll10', 'ndcg10', 'recallAny5', 'recallAny10', 'answerHit5', 'answerHit10'] as const;

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Sample standard deviation; 0 for a single run. */
const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;

/** The metrics of one run over a set of outcomes. Metrics a query doesn't carry are skipped. */
export function summarise(outcomes: QueryOutcome[], writeMs: number[]): Record<string, unknown> {
  const out: Record<string, unknown> = { questions: outcomes.length };
  for (const m of METRICS) {
    const xs = outcomes.map(o => o[m]).filter((x): x is number => typeof x === 'number');
    if (xs.length > 0) { out[m] = round(mean(xs)); out[`${m}N`] = xs.length; }
  }
  out.readMs = percentiles(outcomes.map(o => o.readMs));
  out.writeMs = percentiles(writeMs);
  out.contextTokensPerQuery = Math.round(mean(outcomes.map(o => o.contextTokens)));
  return out;
}

export function perType(outcomes: QueryOutcome[]): Record<string, Record<string, unknown>> {
  const groups = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) groups.set(o.type, [...(groups.get(o.type) ?? []), o]);
  const res: Record<string, Record<string, unknown>> = {};
  for (const [type, os] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = summarise(os, []);
    delete s.writeMs;
    res[type] = s;
  }
  return res;
}

/** Mean and sample standard deviation across runs for every numeric metric and latency percentile. */
export function acrossRuns(runs: Record<string, unknown>[]): Record<string, { mean: number; std: number }> {
  const res: Record<string, { mean: number; std: number }> = {};
  const add = (key: string, xs: number[]) => { res[key] = { mean: round(mean(xs)), std: round(std(xs)) }; };
  for (const m of METRICS) {
    const xs = runs.map(r => r[m]).filter((x): x is number => typeof x === 'number');
    if (xs.length === runs.length && xs.length > 0) add(m, xs);
  }
  for (const lat of ['readMs', 'writeMs'] as const) {
    for (const p of ['p50', 'p95'] as const) {
      add(`${lat}.${p}`, runs.map(r => (r[lat] as Record<string, number>)[p]));
    }
  }
  add('contextTokensPerQuery', runs.map(r => r.contextTokensPerQuery as number));
  return res;
}

export function printSummary(title: string, runs: Record<string, unknown>[], byType: Record<string, Record<string, unknown>>): void {
  const agg = acrossRuns(runs);
  const pct = (k: string) => agg[k] ? `${(agg[k].mean * 100).toFixed(1)}% ±${(agg[k].std * 100).toFixed(1)}` : '—';
  console.log(`\n${'='.repeat(76)}\n${title}\n${'='.repeat(76)}`);
  console.log(`runs ${runs.length} · questions ${runs[0]?.questions} · embedding ${getEmbeddingModelName()}`);
  for (const [type, s] of Object.entries(byType)) {
    const f = (k: string) => typeof s[k] === 'number' ? `${((s[k] as number) * 100).toFixed(1)}%` : '  —  ';
    console.log(`  ${type.padEnd(28)} all@5=${f('recallAll5')} all@10=${f('recallAll10')} ndcg@10=${typeof s.ndcg10 === 'number' ? (s.ndcg10 as number).toFixed(3) : '—'} hit@10=${f('answerHit10')} n=${s.questions}`);
  }
  console.log(`  OVERALL recall_all@5 ${pct('recallAll5')}  recall_all@10 ${pct('recallAll10')}  NDCG@10 ${agg.ndcg10 ? agg.ndcg10.mean.toFixed(3) : '—'}`);
  if (agg.recallAny5) console.log(`          recall_any@5 ${pct('recallAny5')}  recall_any@10 ${pct('recallAny10')}`);
  if (agg.answerHit5) console.log(`          answer_hit@5 ${pct('answerHit5')}  answer_hit@10 ${pct('answerHit10')}`);
  console.log(`  read p50 ${agg['readMs.p50'].mean}ms p95 ${agg['readMs.p95'].mean}ms · write p50 ${agg['writeMs.p50'].mean}ms p95 ${agg['writeMs.p95'].mean}ms · context ${agg.contextTokensPerQuery.mean} tokens/query`);
}

/** Read `--name value` from argv. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function hardware(): Record<string, unknown> {
  return {
    cpu: cpus()[0]?.model?.trim(),
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
    node: process.version,
    embeddingDevice: process.env.ENGRAM_DEVICE ?? 'cpu',
  };
}

/**
 * Run a retrieval benchmark `runs` times, print the summary, and write one result file holding
 * every run, the mean and standard deviation across runs, per-type scores and the first run's
 * per-question outcomes.
 */
export async function runRetrievalBenchmark(spec: {
  benchmark: string;
  title: string;
  runs: number;
  config: Record<string, unknown>;
  notes: string;
  /** Extra result fields known after the runs (e.g. how many questions couldn't be scored). */
  extra?: () => Record<string, unknown>;
  runOnce: (run: number) => Promise<{ outcomes: QueryOutcome[]; writeMs: number[] }>;
}): Promise<void> {
  const started = performance.now();
  const runs: Record<string, unknown>[] = [];
  let first: QueryOutcome[] = [];
  for (let r = 1; r <= spec.runs; r++) {
    console.error(`── ${spec.title}: run ${r}/${spec.runs}`);
    const { outcomes, writeMs } = await spec.runOnce(r);
    runs.push(summarise(outcomes, writeMs));
    if (r === 1) first = outcomes;
  }
  const byType = perType(first);
  printSummary(spec.title, runs, byType);
  const path = writeBenchmarkResult({
    benchmark: spec.benchmark,
    durationMs: Math.round(performance.now() - started),
    config: { ...spec.config, embeddingModel: getEmbeddingModelName(), topK: TOP_K, embedChars: EMBED_CHARS, runs: spec.runs, hardware: hardware(), embedCache: Boolean(embedCacheDir()), ingest: INGEST },
    results: { ...acrossRuns(runs), ...spec.extra?.(), runs },
    perCategory: byType,
    perQuestion: first.map(o => ({
      questionId: o.id, questionType: o.type,
      recall5: o.recallAll5 ?? o.answerHit5 ?? 0, recall10: o.recallAll10 ?? o.answerHit10 ?? 0,
      latencyMs: Math.round(o.readMs), retrievedSessionIds: o.retrieved,
    })),
    notes: spec.notes,
  });
  console.log(`\nResults JSON: ${path}`);
}
