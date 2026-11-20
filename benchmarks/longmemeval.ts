#!/usr/bin/env node

/**
 * LongMemEval retrieval benchmark (Wu et al., ICLR 2025; data MIT, cleaned Sep 2025).
 *
 * Scores retrieval as retrieval: recall_all@5/10 (every evidence item in the top K), NDCG@10,
 * and recall_any@5/10 for continuity with earlier releases. Abstention questions are excluded,
 * as in the official retrieval evaluation. Each question gets its own fresh store holding only
 * its haystack. This is not QA accuracy; see qa.ts.
 *
 * Usage:
 *   npm run bench:longmemeval                                   # S, session level, 1 run
 *   npm run bench:longmemeval -- --variant m --per-type 20      # M, first 20 of each type
 *   npm run bench:longmemeval -- --granularity turn --runs 3
 *   npm run bench:longmemeval -- --limit 50                     # quick check
 */

// Force the local file backend: storage-factory otherwise routes to the cloud when a
// credentials file exists, ignoring the temp data dir.
process.env.STORAGE_BACKEND = 'file';

import { embed } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { loadLongMemEval, lmeCorpus, type Granularity, type LmeVariant } from './lib/datasets.js';
import { arg, evaluateCorpus, runRetrievalBenchmark, type QueryOutcome } from './lib/retrieval.js';

const variant = (arg('variant') ?? 's') as LmeVariant;
const granularity = (arg('granularity') ?? 'session') as Granularity;
const runs = Number(arg('runs') ?? 1);
const perType = arg('per-type') ? Number(arg('per-type')) : undefined;
const limit = arg('limit') ? Number(arg('limit')) : undefined;

await embed(loadConfig(), 'warmup');

let excluded = 0;
await runRetrievalBenchmark({
  benchmark: `longmemeval-${variant}-${granularity}`,
  title: `LongMemEval ${variant.toUpperCase()} · ${granularity} level`,
  runs,
  config: { dataset: `longmemeval_${variant}_cleaned.json`, granularity, perType: perType ?? null, questionLimit: limit ?? null },
  notes:
    'Retrieval only, not QA accuracy. Abstention questions (_abs) excluded, as in the official retrieval evaluation. ' +
    'Session level: evidence = answer_session_ids, one item per session, first 2,000 characters embedded. ' +
    'Turn level: evidence = turns marked has_answer, one item per turn; questions with no such turn excluded. ' +
    'One fresh store per question holding only its haystack. Runs executed on one machine, possibly concurrently with other runs.',
  runOnce: async () => {
    const outcomes: QueryOutcome[] = [];
    const writeMs: number[] = [];
    let n = 0;
    excluded = 0;
    for await (const entry of loadLongMemEval(variant, { perType, limit })) {
      const corpus = lmeCorpus(entry, granularity);
      if (!corpus) { excluded++; continue; }
      const r = await evaluateCorpus(corpus.items, [corpus.query], { label: entry.question_id });
      outcomes.push(...r.outcomes);
      writeMs.push(...r.writeMs);
      if (++n % 25 === 0) console.error(`  ${n} questions`);
    }
    if (excluded > 0) console.error(`  excluded ${excluded} questions with no evidence at ${granularity} level`);
    return { outcomes, writeMs };
  },
});
