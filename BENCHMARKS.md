# Nomad Memory Benchmarks — Methodology Reference

The short version with results lives in the [README](README.md#benchmarks). This document says
what each benchmark measures, how the numbers are computed, and how to reproduce them.

## Contents

- [What we measure, and what we don't](#what-we-measure-and-what-we-dont)
- [Datasets](#datasets)
- [Running](#running)
- [LongMemEval](#longmemeval)
- [BEAM](#beam)
- [MemoryAgentBench](#memoryagentbench)
- [QA accuracy](#qa-accuracy)
- [Reporting norms](#reporting-norms)
- [Result files](#result-files)
- [Operational benchmarks](#operational-benchmarks)
- [Why not LoCoMo](#why-not-locomo)

## What we measure, and what we don't

Two different things get called "memory benchmark scores":

- **Retrieval.** Did the evidence land in the top K results? Computed from the dataset's
  evidence labels, no model in the loop, deterministic up to the run-to-run effects noted
  below. This is what nomad-memory itself does, and what we publish.
- **QA accuracy.** Did a model, reading what was retrieved, answer correctly, as judged by a
  grader model? This depends on the answer model, the grader model and the grading prompt as
  much as on memory. The harness for it is here (`npm run bench:qa`), but we have not
  published QA numbers yet.

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

Common flags: `--runs N` repeats the whole run and reports mean and standard deviation;
`--limit N` and `--per-type N` (LongMemEval) and `--chats N` (BEAM) take a fixed, deterministic
subset. Every run stores each corpus in a fresh local store (LanceDB, file backend forced) and
calls the same `search()` the MCP server calls, top 10, no reranker, no API key.

Two more switches, for all three runners:

- `--ingest chunked` stores each item the way `memory-ingest` does: text over 500 characters
  becomes a parent plus pieces of up to 600 characters, each piece with its own vector. The
  default stores each item whole and embeds its first 2,000 characters, which is what the
  published numbers use. Chunked is closer to the product and returns far less context.
- `BENCH_EMBED_CACHE=<dir>` keeps embeddings on disk between runs. Embedding is most of a
  run's time and doesn't change when only search code does, so comparing two versions takes
  minutes. Write latency is not measured with the cache on; published runs leave it off.

Run one benchmark at a time. Each loads the embedding model and a dataset, and two at once
are no faster on one CPU.

## LongMemEval

[Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813). 500 questions over a per-question
haystack of past chat sessions: about 115K tokens in S, about 1.5M tokens in M. M is far past
any model's context window, so it tests retrieval rather than reading.

- **Abstention questions (the 30 `_abs` ids) are excluded from retrieval scoring**, as in the
  official retrieval evaluation: their labelled sessions don't hold an answer.
- **Session level:** one item per session; evidence is `answer_session_ids`. The first 2,000
  characters of each session are embedded (bge-small reads at most 512 tokens); keyword
  search sees the whole session.
- **Turn level:** one item per turn; evidence is the turns marked `has_answer`. Questions with
  no such turn are excluded and counted in the result file.
- **Metrics:** recall_all@5 and @10 (every evidence item is in the top K), NDCG@10 (binary
  relevance, deduplicated ranking), and recall_any@5 and @10 (at least one evidence item),
  kept for continuity with numbers this project published before.
- Each question gets its own store holding only its haystack, and one query runs against it,
  so a LongMemEval run is deterministic.

## BEAM

[Tavakoli et al., ICLR 2026](https://arxiv.org/abs/2510.27246). Conversations of 128K to 10M
tokens with probing questions in ten categories: abstention, contradiction resolution, event
ordering, information extraction, instruction following, knowledge update, multi-session
reasoning, preference following, summarisation, temporal reasoning. We run 100K, 500K and 1M
(10M is not run).

- One item per message; its source is the message id.
- **Evidence** is the question's `source_chat_ids`, or the `chat_id: N` entries in its
  `conversation_references`. Questions that name no evidence messages (all abstention
  questions, and many others) can't be scored for retrieval and are left to QA; the result
  file counts them.
- Metrics as for LongMemEval. All questions of a chat run against one store, and search bumps
  recall counts as it goes, so later questions see slightly different scores; that is why
  BEAM runs are repeated.

## MemoryAgentBench

[Hu et al., ICLR 2026](https://arxiv.org/abs/2507.05257). Two splits:

- **Conflict_Resolution** (FactConsolidation, single-hop and multi-hop, 6K to 262K tokens):
  numbered facts in which a later fact overrides an earlier one. One item per fact, timestamps
  increasing with the fact number.
- **Accurate_Retrieval** (RULER QA and EventQA): long documents split on blank lines into
  passages of up to 1,500 characters. Its LongMemEval rows are skipped; the LongMemEval
  benchmark covers them. EventQA can't be scored this way: its gold answers are paraphrased
  event descriptions that appear verbatim in the book for 3 of 1,500 questions, so the
  published Accurate_Retrieval numbers are RULER QA only (`--sources
  ruler_qa1_197K,ruler_qa2_421K`).

The dataset labels no evidence passages, so retrieval is scored as **answer_hit@5 and @10**:
does a retrieved item contain a gold answer verbatim (case-insensitive). That is a weaker proxy
than recall over labelled evidence. An unrelated item can contain the answer string, and in
FactConsolidation the overridden fact contains the old answer, not the gold one, so a hit does
not show the system preferred the newer fact. Questions whose answer never appears in the
context can't be scored this way; they are dropped and counted.

## QA accuracy

```bash
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode memory --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode full-context --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark beam --size 100K --mode memory --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark mab-cr --mode full-context --runs 3
npm run bench:qa -- --benchmark lme-s --dry-run      # build the prompts, call nothing
```

- **Memory mode:** the answer model reads the top 10 items `search()` returned.
  **Full-context mode** is the no-memory baseline: it reads the whole history (questions whose
  history exceeds 900K tokens are skipped).
- **Models:** `--answer-model` and `--grader-model`, both defaulting to `claude-opus-5-5`, with
  `--answer-effort` (default `medium`) and `--grader-effort` (default `low`). The key comes
  from `ANTHROPIC_API_KEY`. Refusals count as incorrect; no server-side fallback is used, so
  every answer and grade comes from the named models.
- **On a Claude subscription:** `--provider claude-cli` sends both calls through the Claude
  Code CLI signed in on this machine, so no key is needed. Name models the CLI's way
  (`--answer-model haiku --grader-model sonnet`). The CLI takes no effort setting and reports
  no refusal flag, input tokens are estimated, and every call counts against the
  subscription's usage limits.
- **Grading prompts** are adapted from LongMemEval's official per-type prompts (with its
  off-by-one rule for temporal questions, its knowledge-update and preference rules, and its
  abstention prompt; abstention questions are included in QA). BEAM is graded as a binary pass
  on the dataset's rubric, where the official BEAM scoring grades each rubric item.
  MemoryAgentBench uses the default prompt.
- Every result file records the answer and grader models, efforts and the full prompts.
- **Scores from a Claude grader are not directly comparable with numbers graded by the
  official gpt-4o graders.**

## Reporting norms

Every published number states: the run count and the standard deviation across runs, p50 and
p95 latency for writes and reads, retrieved-context tokens per query, the embedding model
(`Xenova/bge-small-en-v1.5`, 384 dimensions, CPU), and the hardware. Definitions:

- **Write latency:** per item, its embedding time plus its share of the batched store write.
  The harness writes straight to storage, so this excludes the ingest path's KG extraction,
  chunking and taxonomy work (see [Ingest throughput](#ingest-throughput)).
- **Read latency:** one `search()` call, top 10.
- **Context tokens per query:** the tokens (four characters a token) of everything retrieved,
  which is what an answer model would read.
- Runs that execute at the same time on one machine slow each other down; result files say so,
  and latency from such runs is an upper bound.

## Result files

Each run writes `benchmarks/results/<benchmark>-<timestamp>.json` (git-ignored); the ones we
publish are copied to `benchmarks/results/published/`. The envelope: `benchmark`, `version`,
`commit`, `config` (dataset, subset, embedding model, top K, run count, hardware), `results`
(per metric `{ mean, std }`, `readMs.p50` and friends, and the raw per-run summaries),
`perCategory`, `perQuestion` (first run) and `notes`.

Files under `published/` dated before 2026-11 report recall_any with abstention questions
included, under an older harness; they are kept as history, not compared with current ones.

## Operational benchmarks

### Synthetic suite

`npm run bench`: a 15-question smoke test, no download. Its scores move between runs of
identical code (R@5 between 73% and 80%) because search bumps recall counts in the background
while later questions run, so it is a quick check, not evidence.

### Ingest throughput

`npm run bench:throughput` pushes N synthetic chunks (default 10,000) through `wal.ingest()` and
reports chunks per second, cold and warm. KG extraction is skipped to stay key-free.

### Query latency

`npm run bench:latency` loads N synthetic chunks and reports p50, p95 and p99 of `search()` per
query length bucket.

## Why not LoCoMo

This project used to publish LoCoMo numbers. It no longer does: about 6% of its gold answers
are wrong, its conversations fit in a model's context window (so a full-context baseline beats
memory systems), and abstention is left unscored.
