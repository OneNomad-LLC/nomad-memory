#!/usr/bin/env node

/**
 * MemoryAgentBench retrieval benchmark (Hu et al., ICLR 2026; MIT).
 *
 * Splits: Conflict_Resolution (FactConsolidation: numbered facts where a later fact overrides
 * an earlier one) and Accurate_Retrieval (RULER QA and EventQA; its LongMemEval rows are skipped
 * because the LongMemEval benchmark covers them). The dataset labels no evidence passages, so
 * retrieval is scored as answer_hit@5/10: does a retrieved item contain a gold answer verbatim.
 * That is a proxy, weaker than recall over labelled evidence: an unrelated fact can contain the
 * answer string, and for FactConsolidation the overridden fact contains the old answer, not
 * the gold one. Questions whose answer never appears in the context are dropped and counted.
 *
 * Usage:
 *   npm run bench:mab -- --split Conflict_Resolution
 *   npm run bench:mab -- --split Accurate_Retrieval --sources ruler_qa1_197K,eventqa_65536 --runs 3
 */

process.env.STORAGE_BACKEND = 'file';

import { embed } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { loadMab, mabCorpus, type MabSplit } from './lib/datasets.js';
import { arg, evaluateCorpus, runRetrievalBenchmark, type QueryOutcome } from './lib/retrieval.js';

const split = (arg('split') ?? 'Conflict_Resolution') as MabSplit;
const runs = Number(arg('runs') ?? 1);
const only = arg('sources')?.split(',');
const rows = (await loadMab(split)).filter(r =>
  !r.metadata.source.startsWith('longmemeval') && (!only || only.includes(r.metadata.source)));

await embed(loadConfig(), 'warmup');

let unscorable = 0;
await runRetrievalBenchmark({
  benchmark: `mab-${split.toLowerCase().replace(/_/g, '-')}`,
  title: `MemoryAgentBench ${split}`,
  runs,
  config: { dataset: `MemoryAgentBench ${split}`, sources: rows.map(r => r.metadata.source) },
  notes:
    'Retrieval proxy, not QA accuracy: answer_hit@k = a retrieved item contains a gold answer verbatim (case-insensitive). ' +
    'No evidence labels exist, so recall_all and NDCG are not computed. Questions whose answer is absent from the context are dropped. ' +
    'FactConsolidation: one item per numbered fact, timestamps increasing with the fact number. Other sources: blank-line passages up to 1,500 characters. ' +
    'Runs executed on one machine, possibly concurrently with other runs.',
  extra: () => ({ droppedQuestions: unscorable }),
  runOnce: async () => {
    const outcomes: QueryOutcome[] = [];
    const writeMs: number[] = [];
    unscorable = 0;
    for (const row of rows) {
      const corpus = mabCorpus(row);
      unscorable += corpus.unscorable;
      const r = await evaluateCorpus(corpus.items, corpus.queries, { label: row.metadata.source });
      outcomes.push(...r.outcomes);
      writeMs.push(...r.writeMs);
      console.error(`  ${row.metadata.source}: ${corpus.items.length} items, ${corpus.queries.length} questions (${corpus.unscorable} unscorable)`);
    }
    console.error(`  ${unscorable} questions dropped: answer not in context`);
    return { outcomes, writeMs };
  },
});
