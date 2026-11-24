# Nomad Memory benchmarks: methods and comparisons

The [README](README.md#benchmarks) has the headline numbers. This document says what each
benchmark measures, how the numbers are computed, how to reproduce them, and how they sit
next to what other memory systems publish.

## Contents

- [What we measure, and what we don't](#what-we-measure-and-what-we-dont)
- [Datasets](#datasets)
- [Running](#running)
- [LongMemEval](#longmemeval)
- [BEAM](#beam)
- [MemoryAgentBench](#memoryagentbench)
- [QA accuracy](#qa-accuracy)
- [How this compares](#how-this-compares)
- [Reporting norms](#reporting-norms)
- [Result files](#result-files)
- [Operational benchmarks](#operational-benchmarks)
- [Why not LoCoMo](#why-not-locomo)

## What we measure, and what we don't

Two different things get called "memory benchmark scores".

Retrieval asks whether the evidence landed in the top K results. It is computed from the
dataset's evidence labels with no model in the loop, and it is deterministic apart from the
run-to-run effects noted below. This is what nomad-memory itself does.

QA accuracy asks whether a model, reading what was retrieved, answered correctly, as judged
by a second model. It depends on the answering model, the judge and the grading prompt as
much as on memory. We have run it once, on a 70-question sample of LongMemEval S; see
[QA accuracy](#qa-accuracy).

Retrieval recall is not QA accuracy, and we don't report one as the other.

## Datasets

All open source, fetched by `bash benchmarks/download-datasets.sh [lme] [lme-m] [beam] [mab]`
into `benchmarks/data/` (git-ignored). With no arguments it fetches `lme`, `beam` and `mab`;
`lme-m` is 2.7 GB and must be named.

| Dataset | Source | Licence |
|---|---|---|
| LongMemEval S and M, cleaned (Sep 2025) | [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | MIT |
| BEAM 100K, 500K, 1M | [mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) | code MIT, data CC BY-SA 4.0 |
| MemoryAgentBench | [ai-hyz/MemoryAgentBench](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench) | MIT |

## Running

```bash
npm run bench:longmemeval                                        # S, session level
npm run bench:longmemeval -- --granularity turn                  # S, turn level
npm run bench:longmemeval -- --variant m --per-type 20           # M, first 20 of each type
npm run bench:beam -- --size 100K --runs 3
npm run bench:mab -- --split Conflict_Resolution --runs 3
npm run bench:mab -- --split Accurate_Retrieval
```

`--runs N` repeats the whole run and reports mean and standard deviation. `--limit N` and
`--per-type N` (LongMemEval) and `--chats N` (BEAM) take a fixed subset, the same one every
time. Every run stores each corpus in a fresh local store (LanceDB, file backend forced) and
calls the same `search()` the MCP server calls: top 10, no reranker, no API key.

Two more switches work on all three runners.

`--ingest chunked` stores each item the way `memory-ingest` does: text over 500 characters
becomes a parent plus pieces of up to 600 characters, each piece with its own vector. The
default stores each item whole and embeds its first 2,000 characters, which is what the
published numbers use. Chunked is closer to the product and returns far less context (about
830 tokens a query on BEAM 100K, against 7,000).

`BENCH_EMBED_CACHE=<dir>` keeps embeddings on disk between runs. Embedding takes most of a
run's time and doesn't change when only the search code does, so with the cache on, comparing
two versions takes minutes. The cache skips the embedding step, so write latency isn't
measured; leave it off for a run whose latency you mean to publish.

Run one benchmark at a time. Each loads the embedding model and a dataset, and two at once
are no faster on one CPU.

## LongMemEval

[Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813). 500 questions over a per-question
haystack of past chat sessions: about 115K tokens in S, about 1.5M tokens in M. M is far past
any model's context window, so a model can't simply read it all.

Abstention questions (the 30 `_abs` ids) are excluded from retrieval scoring, as in the
official retrieval evaluation: their labelled sessions don't hold an answer.

At session level each session is one item and the evidence is `answer_session_ids`. The first
2,000 characters of each session are embedded (bge-small reads at most 512 tokens); keyword
search sees the whole session. At turn level each turn is one item and the evidence is the
turns marked `has_answer`. Questions with no such turn are excluded and counted in the result
file.

We report recall_all@5 and @10 (every evidence item is in the top K), NDCG@10 (binary
relevance, deduplicated ranking), and recall_any@5 and @10 (at least one evidence item), which
we keep because this project published it before.

Each question gets its own store holding only its haystack, and one query runs against it, so
a LongMemEval run gives the same result every time.

## BEAM

[Tavakoli et al., ICLR 2026](https://arxiv.org/abs/2510.27246). Conversations of 128K to 10M
tokens with probing questions in ten categories: abstention, contradiction resolution, event
ordering, information extraction, instruction following, knowledge update, multi-session
reasoning, preference following, summarisation, temporal reasoning. We run 100K, 500K and 1M;
10M is not run.

Each message is one item, and its source is the message id. The evidence is the question's
`source_chat_ids`, or the `chat_id: N` entries in its `conversation_references`. Questions
that name no evidence messages (all abstention questions, and many others) can't be scored
for retrieval and are left to QA; the result file counts them.

The metrics are the same as for LongMemEval. All questions of a chat run against one store,
and search bumps recall counts as it goes, so later questions see slightly different scores.
That is why BEAM runs are repeated.

About half of the evidence BEAM retrieval misses is out of reach of search: the question
shares neither words nor meaning with it. "Could you show me how to implement a login
feature?" has as its evidence an instruction, given weeks earlier, to always format code with
syntax highlighting. Standing instructions like that are the job of procedural rules, which
nomad-memory pushes into every session; this benchmark doesn't exercise them.

## MemoryAgentBench

[Hu et al., ICLR 2026](https://arxiv.org/abs/2507.05257). We run two splits.

Conflict_Resolution (FactConsolidation, single-hop and multi-hop, 6K to 262K tokens) is a list
of numbered facts in which a later fact overrides an earlier one. Each fact is one item, with
timestamps increasing with the fact number.

Accurate_Retrieval (RULER QA and EventQA) is long documents, which we split on blank lines
into passages of up to 1,500 characters. Its LongMemEval rows are skipped, because the
LongMemEval benchmark covers them. EventQA can't be scored this way: its gold answers are
paraphrased event descriptions that appear verbatim in the book for 3 of 1,500 questions. So
the published Accurate_Retrieval numbers are RULER QA only (`--sources
ruler_qa1_197K,ruler_qa2_421K`).

The dataset labels no evidence passages, so retrieval is scored as answer_hit@5 and @10: does
a retrieved item contain a gold answer verbatim (case-insensitive). That is a weaker proxy
than recall over labelled evidence. An unrelated item can contain the answer string, and in
FactConsolidation the overridden fact contains the old answer, not the gold one, so a hit
does not show the system preferred the newer fact. Questions whose answer never appears in
the context can't be scored this way; they are dropped and counted.

## QA accuracy

```bash
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode memory --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode full-context --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark beam --size 100K --mode memory --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark mab-cr --mode full-context --runs 3
npm run bench:qa -- --benchmark lme-s --per-type 10 --provider claude-cli   # a sample, on a Claude subscription
npm run bench:qa -- --benchmark lme-s --dry-run      # build the prompts, call nothing
```

In memory mode the answering model reads the top 10 items `search()` returned. Full-context
mode is the no-memory baseline: the model reads the whole history, and questions whose
history exceeds 900K tokens are skipped.

`--answer-model` and `--grader-model` both default to `claude-opus-5-5`, with `--answer-effort`
(default `medium`) and `--grader-effort` (default `low`). The key comes from
`ANTHROPIC_API_KEY`. Refusals count as incorrect, and there is no server-side fallback, so
every answer and grade comes from the named models.

To run on a Claude subscription, pass `--provider claude-cli`. Both calls then go through the
Claude Code CLI signed in on this machine and need no key. Name models the CLI's way
(`--answer-model haiku --grader-model sonnet`). The CLI takes no effort setting and reports no
refusal flag, input tokens are estimated, and every call counts against the subscription's
usage limits.

To grade with the judge LongMemEval's own script uses, pass `--grader-provider openrouter
--grader-model openai/gpt-4o-2024-08-06` with `OPENROUTER_API_KEY` set. The call uses the
official settings: temperature 0 and ten tokens for a yes or a no. `--extra-grader
provider:model` has a second judge grade the same answers and reports how often the two agree.

The grading prompts are adapted from LongMemEval's official per-type prompts, with its
off-by-one rule for temporal questions, its knowledge-update and preference rules, and its
abstention prompt. Abstention questions are included in QA. BEAM is graded as a binary pass on
the dataset's rubric, where the official BEAM scoring grades each rubric item.
MemoryAgentBench uses the default prompt. Every result file records the models, the efforts
and the full prompts.

### The run we have

One run, on 2026-11-24, at commit `9226c51`. The result file is
[`qa-longmemeval-s-memory-sample70-gpt4o-2026-11-24.json`](benchmarks/results/published/qa-longmemeval-s-memory-sample70-gpt4o-2026-11-24.json).

It covers 70 LongMemEval S questions: the first ten of each of the six question types, plus
the first ten abstention questions. Claude Sonnet (the CLI's `sonnet` alias) answered each
one after reading the top 10 sessions nomad-memory retrieved, about 30,000 tokens a question.

| Judge | Correct | Accuracy |
|---|---|---|
| `gpt-4o-2024-08-06`, the official judge | 68 of 70 | 97.1% |
| Claude Sonnet, same answers | 65 of 70 | 92.9% |

The two judges agreed on 67 of the 70. Each time they split, gpt-4o passed the answer and
Sonnet failed it, so a gpt-4o-graded score runs a few points above what a stricter judge
gives. Under gpt-4o the two misses were one preference question and one temporal-reasoning
question; every other type scored 10 of 10.

What this run doesn't show:

- With 70 questions the true figure is somewhere between about 90% and 99%. The full set is 500.
- Ten questions of each type is not the benchmark's own mix, which has 133 temporal-reasoning
  questions and 30 preference ones.
- The full-context baseline hasn't run, so there is no measure yet of what memory adds over
  handing Sonnet the whole history.
- Sonnet read whole sessions. The product returns short pieces, and that path hasn't been run
  for QA.
- BEAM and MemoryAgentBench QA haven't run.

## How this compares

Checked on 2026-11-24. Other systems' numbers are the ones their authors publish.

### Retrieval

Few systems publish retrieval recall on its own. MemPalace does: 96.6% recall_any@5 on
LongMemEval S in its raw mode, over all 500 questions
([its benchmarks](https://github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md)).
Nomad Memory scores 96.8% on the same measure over the 470 questions that have evidence. The
question sets differ by the 30 abstention questions, so call it level.

The measure is forgiving. A [critique of MemPalace](https://arxiv.org/abs/2604.21284) reports
getting its 96.6% from a default embedding model over verbatim text with nothing else. The
stricter recall_all@10 is the number we lead with: 94.9% on S.

### Answer accuracy on LongMemEval S

| System | Accuracy | Model answering | Questions | Source |
|---|---|---|---|---|
| Nomad Memory | 97.1% | Claude Sonnet | 70 (sample) | [the run above](#the-run-we-have) |
| Mastra, observational memory | 94.9% | gpt-5-mini | 500 | [Mastra](https://mastra.ai/research/observational-memory) |
| Mem0, token-efficient algorithm | 94.4% | not named | 500 | [Mem0](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) |
| Hindsight | 91.4% | Gemini 3 Pro | 500 | [Hindsight paper](https://arxiv.org/abs/2512.12818) |
| Supermemory | 85.2% | Gemini 3 Pro | 500 | [a third-party review](https://dev.to/andrew-ooo/supermemory-review-1-ai-memory-engine-on-longmemeval-3k0e), citing Supermemory |
| Mastra, observational memory | 84.2% | gpt-4o | 500 | [Mastra](https://mastra.ai/research/observational-memory) |
| Supermemory | 81.6% | gpt-4o | 500 | [Hindsight paper](https://arxiv.org/abs/2512.12818), citing Supermemory |
| Zep | 71.2% | gpt-4o | 500 | [Zep paper](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf) |

Read the table as a rough guide. These numbers were not produced the same way.

- The model answering moves the score as much as the memory does. Mastra's own system scores
  84.2% with gpt-4o and 94.9% with gpt-5-mini. Ours used a current Claude Sonnet, which is
  newer than gpt-4o.
- Ours is a 70-question sample with an even mix of types. The others ran all 500.
- Context size differs. Sonnet read about 30,000 tokens a question; Mem0 reports about 6,800.
- Vendors report their own numbers, and independent reruns come out lower.
  [One paper](https://arxiv.org/abs/2610.24671) measured Mem0 at 57.0% on LongMemEval S in
  its own setup.
- Scores are counted differently. [An audit](https://arxiv.org/abs/2609.38021) says Mastra's
  94.9% is an average over question types, and that its raw count is 468 of 500 (93.6%).
- Zep's paper is the only one here that reports its no-memory baseline in the same table:
  60.2% for gpt-4o reading the full history.

### BEAM

Published BEAM scores are answer accuracy. Mem0 reports 64.1% at 1M tokens and 48.6% at 10M
([Mem0](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)). We have only retrieval on BEAM so
far: every evidence message in the top 10 for 22.9% of questions at 100K, and at least one
for 53.3%. A retrieval rate and an answer rate can't be set side by side, and we haven't run
BEAM QA.

## Reporting norms

Every published number states the run count and the standard deviation across runs, p50 and
p95 latency for writes and reads, retrieved-context tokens per query, the embedding model
(`Xenova/bge-small-en-v1.5`, 384 dimensions, CPU), and the hardware.

Write latency is, per item, its embedding time plus its share of the batched store write. The
benchmark writes straight to storage, so this leaves out the ingest path's KG extraction,
chunking and taxonomy work (see [Ingest throughput](#ingest-throughput)). Read latency is one
`search()` call, top 10. Context tokens per query is the size of everything retrieved, at
four characters a token, which is what an answering model would read.

Runs that execute at the same time on one machine slow each other down. Result files say so,
and latency from such runs is an upper bound.

## Result files

Each run writes `benchmarks/results/<benchmark>-<timestamp>.json` (git-ignored); the ones we
publish are copied to `benchmarks/results/published/`. Each file holds `benchmark`, `version`,
`commit`, `config` (dataset, subset, embedding model, top K, run count, hardware), `results`
(per metric `{ mean, std }`, `readMs.p50` and friends, and the raw per-run summaries),
`perCategory`, `perQuestion` (first run) and `notes`.

The retrieval files under `published/` dated 2026-11-20 predate BM25 keyword search. The
LongMemEval S and BEAM 100K recall figures quoted here and in the README were measured on
2026-11-24 with the embedding cache on, which doesn't change recall. LongMemEval M,
BEAM 500K and 1M, and MemoryAgentBench have not been re-run since.

Files dated before 2026-11 report recall_any with abstention questions included, from an
older version of the benchmark code. They are kept as history and not compared with current
ones.

## Operational benchmarks

### Synthetic suite

`npm run bench`: a 15-question smoke test, no download. Its scores move between runs of
identical code (R@5 between 73% and 80%) because search bumps recall counts in the background
while later questions run. Use it as a quick check and nothing more.

### Ingest throughput

`npm run bench:throughput` pushes N synthetic chunks (default 10,000) through `wal.ingest()` and
reports chunks per second, cold and warm. KG extraction is skipped so it needs no key.

### Query latency

`npm run bench:latency` loads N synthetic chunks and reports p50, p95 and p99 of `search()` per
query length bucket.

## Why not LoCoMo

This project used to publish LoCoMo numbers. It no longer does: about 6% of its gold answers
are wrong, its conversations fit in a model's context window (so a full-context baseline beats
memory systems), and abstention is left unscored.
