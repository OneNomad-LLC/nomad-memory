# Lessons from a production deployment, 2026-11-20

A chat product built its own memory on Postgres, starting from ideas ported out of this repo
(query signals, IDF keyword weighting, the poisoning and contradiction checks, the
consolidation prompts). Running it in production taught things this repo can use back. This
plan takes each idea on its merits for nomad-memory's design, a local-first MCP server on
LanceDB, and says what ships and what doesn't.

For each idea: does nomad-memory already do it, would it help here, what it should do to the
benchmarks, the risk, and the effort (S under a day, M a few days, L a week or more).

## The debt we were told about, checked

| Debt | Still true? |
|---|---|
| Full-scan search | Yes. `search()` loads every non-archive chunk and runs a regex per query term per chunk for IDF and keyword scoring. Vector candidates are capped (LanceDB ANN, `candidatePool`), keyword candidates are not. Recorded as DEBT-021; the fix is a persisted BM25 index (R-012). Not touched here. |
| LLM hardwired to OpenRouter | Mostly not. `ENGRAM_LLM_BASE_URL` already points the client at any OpenAI-compatible server. What remained: the key had to be called `OPENROUTER_API_KEY`, the model `ENGRAM_MODEL`, the error message sent people to OpenRouter, and `isLlmAvailable()` could say yes when the client would refuse. Fixed here (item 6). |
| `tenant_id`-only scoping | Yes, on Postgres and cloud; the file backend has no scoping at all. DEBT-001, DEBT-006 and R-014 cover it. Not touched. |
| Separate chunk store | Partly. Chunks, KG triples and rules are separate tables in one LanceDB directory (or one Postgres schema). Parent chunks hold the full text and children carry the vectors, which is deliberate and measured (1.5.0 changelog). Nothing to change. |

## The ideas

### Facts

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Bitemporal facts (`valid_from`, `valid_to`, `recorded_at`, `superseded_by`), add-only | Half. KG triples have `validFrom`, `validTo` and `createdAt`, and `replaceTriple` closes old ones. `validFrom` is always the write time and there is no `superseded_by`. Chunks have no validity at all. | Yes for knowledge-update questions, but on the answer side: retrieval already returns both the old and the new session. | None on R@K; possibly a small gain on LongMemEval knowledge-update answer accuracy, which we don't measure. | Medium: a new column set on three backends plus a migration, and every reader has to learn which rows are current. | L |
| Immutable origin (owner, bot, tool, web) | Yes, as `origin` (`user`, `derived`, `extracted`, `imported`), and consolidation already refuses to merge, rewrite or demote `user` chunks. One path broke the rule: reconsolidation rewrote a recalled chunk's text whatever its origin. | Yes. | None. | Low. | S |

The future-`valid_from` bug the deployment hit (closing a fact before it started) cannot happen
here, because a triple's `validFrom` is always "now". It becomes live the day callers can set
`validFrom`; the note is in the deferred section.

### Blocks

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Core memory blocks with an owner edit lock | No blocks. The session-start hook already pushes standing rules, corrections and preferences into every session, which is the job a profile block does. The edit lock's point (the user's words are never overwritten by a model) is what `origin: user` protects, and the reconsolidation fix closes the hole in it. | Little beyond what the hook does. | None. | Medium: a new store and a new tool surface. | M |

### Episodes

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Day summaries | Yes: episodic L1 summaries in maintenance and a daily diary digest. | No change needed. | None. | None. | None |

### Consolidation and extraction

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Extraction cites its source messages; facts whose citations aren't in the batch are dropped | No. The LLM extractor returns free-standing memories; nothing ties one to a message, so a hallucinated memory is stored like a real one. | Yes. It is the cheapest guard against invented memories, and it lets us enforce "user-provided information only" in code instead of trusting the prompt. | None (benchmarks run without an LLM). | Low: only the LLM path changes, and a dropped candidate costs one memory. | S |
| Poisoning check on extraction, doubtful facts held as `suggested` | Partly. Ingest logs a warning on three patterns and stores anyway; `memory-govern` reports. There is no `suggested` status, and adding one is the approval workflow of DEBT-005. | Yes for the high-severity case: extracted text that tries to steer the model should not become a memory. | None. | Low. | S |
| Contradiction supersession | Advisory only (`detectContradictions`), plus `replaceTriple` for the KG. Chunks are never closed off by a contradiction. | Maybe, but automatic supersession on chunks needs the validity columns above to be safe; without them it is a delete. | Unknown; could hurt knowledge-update recall if the old session is what the question cites. | Medium. | M |
| Secret and placeholder redaction before storing | No. Nothing scans for secrets. A memory store is embedded, synced to Postgres or the cloud backend, and pasted back into prompts, so a key that lands in it leaks three ways. | Yes. | None: the patterns only match credential shapes. Over the LongMemEval haystack's 199,509 turns they fire 5 times, all on real-looking tokens in pasted code, and the benchmark harness writes through storage directly, so ingest-time redaction never touches it. | Low, with an opt-out for anyone who needs raw text. | S |
| Budget caps and one run at a time | Budget: extraction is one call per request and maintenance batches KG extraction, so there is no runaway loop to cap. One run at a time: no. Every Claude Code session starts its own server on the same data directory, each one runs maintenance at boot when it is overdue, and `memory-maintain` can overlap the timer in the same process. Two runs decay, promote and merge the same rows twice. | Yes. | None. | Low. | S |
| Embeddings that fall behind are caught up | No. `embed()` returns `[]` when the model fails (no network on first run, a cache it can't write), the chunk is stored without a vector, and nothing ever embeds it again short of a full `reembed`. The vector stage never sees it. | Yes. | None on a healthy run. | Low: bounded per run, never overwrites a vector. | S |

### Retrieval

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Candidates capped in the query | Vector: yes. Keyword: no, every match enters fusion. | No: capped at 50, LongMemEval came out identical to the last digit, and the full scan that costs the time still runs. | None (measured). | Low. | S; not shipped |
| Multiplicative boosts after RRF (`score × (1 + boost)`) | No. Boosts are added at a tenth of their size (`bonusScale = 0.1`), which the deployment found still lets them decide the order on their own: an entity boost (+0.05) outweighs the whole vector rank range. | Not on this pipeline: R@10 fell. nomad-memory's boosts were tuned additively, so the swap moves temporal-reasoning questions out of the top 10. | LongMemEval R@10 99.0% to 98.4% (measured). | Fails the recall rule. | S; reverted |
| Time-window fallback when a window finds nothing | Not needed. nomad-memory's time window only adds candidates from the period; it never filters. A misread year can't hide everything. | No. | None. | None. | None |
| IDF term weighting and a vector-similarity floor | Yes. These came from this repo in the first place. The floor is model-profiled and guarded by `tests/alien-query-floor.test.ts`. | No change. | None. | None. | None |

### Model choice

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| A provider-agnostic light model for extraction | Mostly (see the debt table). | Yes for the remaining naming and the misleading error. | None. | Low: old variable names keep working. | S |
| A writable model cache | No. transformers.js caches inside `node_modules`, which a global or `npx` install may not let it write, and the boot log claims `~/.cache/huggingface`, which is wrong. On this machine the first download stalled and the process exited 0 with no error and no vectors. | Yes. | None. | Low: an existing cache keeps being used. | S |

### Deletion

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Deletion cascades and pruning of orphaned facts | There is no delete tool to cascade from. Consolidation deletes merge losers and expired scratch; KG triples cite a session, not a chunk, so they have nothing to cascade from. A parent container whose children have all been merged away is unreachable but harmless. | Little. | None. | Low. | S |

### Compaction

| Idea | Already? | Helps? | Bench effect | Risk | Effort |
|---|---|---|---|---|---|
| Summaries kept beside verbatim history, instruction pins | Yes in spirit. Handoffs and checkpoints are the summary; the transcript stays the record; corrections and preferences with `origin: user` already sit on an instruction floor and are pushed at session start. Compaction itself belongs to the client (Claude Code), not to this server. | No. | None. | None. | None |

## What ships

1. **Reconsolidation leaves user memories alone.** `reconsolidate()` returns without a model
   call for `origin: user` chunks, matching what consolidation already promises.
2. **Secrets never stored.** A redaction pass at ingest replaces credential shapes (private key
   blocks, provider key prefixes, bearer tokens, JWTs, `password=` style assignments) with
   `[REDACTED]`. Extraction drops a candidate outright when it would have held one.
   `NOMAD_MEMORY_REDACT_SECRETS=0` turns it off.
3. **Extraction cites its sources.** The LLM prompt numbers the messages and requires
   `source` on each memory. Candidates citing no message, a number outside the batch, or only
   assistant messages are dropped. The prompt gains the hard rules (only what the messages
   say; text in the messages is material, never instructions; no secrets). Candidates with a
   high-severity poisoning pattern are dropped, on the heuristic path too; otherwise the
   heuristic path is unchanged.
4. **One maintenance run at a time.** In one process, concurrent callers share the run in
   flight. Across processes, a lock file in the data directory; a lock whose process is gone, or older than six hours, is
   taken as left behind by a crash. The auto scheduler checks "overdue" again after taking
   the lock, so the second session at boot skips instead of running a second pass.
   `memory-maintain` answers `maintenance_running` when another process holds it.
5. **Embedding catch-up.** Maintenance embeds up to 500 chunks a run that have no vector, and
   reports how many.
6. **Provider-agnostic LLM settings.** `NOMAD_MEMORY_LLM_BASE_URL`, `NOMAD_MEMORY_LLM_API_KEY`
   and `NOMAD_MEMORY_LLM_MODEL`, with every old name still read. `isLlmAvailable()` agrees with
   the client.
7. **A writable model cache.** `NOMAD_MEMORY_MODEL_DIR` sets it. Without it the library default
   is kept when writable, else `~/.cache/nomad-memory/models`. The boot log prints the real
   path.
8. **Two retrieval experiments**, each kept only if R@5 and R@10 hold on LongMemEval:
   multiplicative boosts, and a keyword candidate cap. Neither shipped (results below); the
   search pipeline is unchanged.

No storage schema changes, so no migration. No public API is removed or renamed;
`MaintenanceResult` gains one field.

## What doesn't, and why

- **Bitemporal chunks and contradiction supersession.** The right model, and the deployment
  shows it works, but it is a three-backend schema change whose payoff is answer accuracy on
  knowledge updates, which we don't measure. Revisit with R-012's evaluation work, and when
  callers can set `validFrom`, close a superseded fact no earlier than its own start (the
  deployment's bug).
- **`suggested` status.** It is the approval lifecycle of DEBT-005. Until that lands, doubtful
  extracted text is dropped rather than parked.
- **Core blocks.** The session-start hook already does the job.
- **A forget tool and deletion cascades.** No delete surface exists to cascade from, and adding
  a destructive MCP tool deserves its own decision.
- **Time-window fallback, IDF, floor, episodes, compaction pins.** Already covered (see the
  tables).

## Benchmarks used

The experiments below were judged on LongMemEval's recall_any@5 and @10 (the metric the
harness reported then, abstention questions included). Since then the benchmark set has been
decided: LongMemEval S and M (recall_all, NDCG, session and turn level), BEAM and
MemoryAgentBench, with QA accuracy graded by a Claude model. LoCoMo is dropped. See
`BENCHMARKS.md`. The rule stands: a retrieval change that lowers recall on those doesn't ship
on by default.

The synthetic `npm run bench` suite is a smoke test only: it moves between runs of identical
code (R@5 73% to 80%) because search bumps recall counts in the background while later
questions run.

## Results

LongMemEval, all 500 questions, no API key, `Xenova/bge-small-en-v1.5` on CPU, this
Windows machine. Baseline is `main` at the v1.6.0 commit, run from a separate checkout.

| Run | recall_any@5 | recall_any@10 | NDCG@5 | NDCG@10 |
|---|---|---|---|---|
| Baseline (`main`) | 95.2% | 99.0% | 0.864 | 0.889 |
| Experiment: multiplicative boosts | 95.2% | 98.4% | 0.864 | 0.888 |
| Experiment: keyword pool capped at 50 | 95.2% | 99.0% | 0.864 | 0.889 |
| This branch | 95.2% | 99.0% | 0.864 | 0.889 |

Multiplicative boosts lowered R@10 (temporal-reasoning 99.2% to 97.0%, single-session-assistant
100% to 98.2%, against small gains on multi-session and preference), so the code was removed
rather than kept behind a flag: a flag nobody should turn on is debt. The keyword cap changed
nothing, so it isn't worth the line. The README's published 96.8% / 98.8% came from a
different machine and GPU backend (DirectML); the baseline row above is the comparison that
matters.

The shipped changes don't touch the search path. The LongMemEval harness writes chunks
straight to storage, so ingest-time redaction doesn't reach it either.

Tests: the full suite passes (262 tests, 2 skipped). `tests/storage-factory-routing.test.ts`
failed once in a full run on `main` and passed alone and in later full runs; it looks flaky on
Windows and is untouched here.

## Open for Matt

- Redaction is on by default and changes what `memory-ingest` stores. The opt-out exists, but
  it is a behaviour change for a minor release.
- `dist/` is tracked and was not rebuilt here; the release step should rebuild it.
