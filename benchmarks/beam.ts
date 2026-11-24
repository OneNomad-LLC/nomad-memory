#!/usr/bin/env node

/**
 * BEAM retrieval benchmark (Tavakoli et al., ICLR 2026; code MIT, data CC BY-SA 4.0).
 *
 * Each chat (128K to 1M tokens) is stored message by message, then every probing question that
 * names its evidence messages (`source_chat_ids`, or "chat_id: N" references) is scored with
 * recall_all@5/10, NDCG@10 and recall_any@5/10. Questions that name no evidence (abstention,
 * summarisation, most preference and instruction-following questions) are left to QA (qa.ts).
 *
 * Usage:
 *   npm run bench:beam -- --size 100K
 *   npm run bench:beam -- --size 1M --chats 5 --runs 3
 */

process.env.STORAGE_BACKEND = 'file';

import { embed } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { listBeamChats, loadBeamChat, type BeamSize } from './lib/datasets.js';
import { arg, evaluateCorpus, runRetrievalBenchmark, type QueryOutcome } from './lib/retrieval.js';

const size = (arg('size') ?? '100K') as BeamSize;
const runs = Number(arg('runs') ?? 1);
const chats = listBeamChats(size).slice(0, arg('chats') ? Number(arg('chats')) : undefined);

await embed(loadConfig(), 'warmup');

let unscored = 0;
let total = 0;
await runRetrievalBenchmark({
  benchmark: `beam-${size}`,
  title: `BEAM ${size}`,
  runs,
  config: { dataset: `BEAM ${size}`, chats: chats.length },
  notes:
    'Retrieval only, not QA accuracy. One item per message; evidence = source_chat_ids or "chat_id: N" in conversation_references. ' +
    'Questions naming no evidence messages are not scored here (counted in results.unscoredQuestions). ' +
    'One fresh store per chat. Runs executed on one machine, possibly concurrently with other runs.',
  extra: () => ({ unscoredQuestions: unscored, totalQuestions: total }),
  runOnce: async () => {
    const outcomes: QueryOutcome[] = [];
    const writeMs: number[] = [];
    unscored = 0;
    total = 0;
    for (const id of chats) {
      const chat = loadBeamChat(size, id);
      const scored = chat.queries.filter(q => q.relevant);
      total += chat.queries.length;
      unscored += chat.queries.length - scored.length;
      const r = await evaluateCorpus(chat.items, scored, { label: `${size}/${id}` });
      outcomes.push(...r.outcomes);
      writeMs.push(...r.writeMs);
      console.error(`  chat ${id}: ${chat.items.length} messages, ${scored.length}/${chat.queries.length} questions scored`);
    }
    console.error(`  ${unscored} of ${total} questions name no evidence and are left to QA`);
    return { outcomes, writeMs };
  },
});
