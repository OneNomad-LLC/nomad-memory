# Nomad Memory: full reference

> The long reference. The short intro is the [README](../README.md).

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square&labelColor=1a1a1a)](../LICENSE)

Project codename: `engram`. The repo is [`OneNomad-LLC/nomad-memory`](https://github.com/OneNomad-LLC/nomad-memory) and the npm package is `@onenomad/nomad-memory` (formerly `@onenomad/przm-memory`).

A memory system for AI agents. LLMs can't remember anything between conversations by default, and the existing solutions are either too simple (just dump everything in a vector DB) or too expensive (send your entire history to an API every time). Nomad Memory sits in the middle. It runs locally and doesn't need an API key for basic operation. On LongMemEval S it puts every evidence session in its top 10 for 93.6% of questions, with no API key; on the much larger LongMemEval M haystacks and on BEAM's long multi-domain chats it does markedly worse, and the [benchmark results](#benchmark-results) show both.

The core idea is that memory shouldn't just be "find similar text." When someone asks "where was I working last March?" the system needs to actually reason about time, not just pattern match on the word "March." So the search pipeline combines vector similarity, keyword matching with IDF weighting, temporal inference, a knowledge graph, and spreading activation over a memory graph. Each piece handles a different kind of recall that the others miss.

## Table of Contents

- [Benchmark Results](#benchmark-results)
- [How It Works](#how-it-works)
- [Compatibility](#compatibility)
- [Installation](#installation) (Claude Code, Claude Desktop, Cursor/Windsurf/Cline, Source)
- [Configuration](#configuration)
- [Tools](#tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Benchmarks](#benchmarks)
- [Security](#security)
- [Use Cases](#use-cases)
- [Pairs Well With: przm Voice (persona)](#pairs-well-with-przm-voice-persona)
- [License](#license)

## Benchmark Results

Retrieval only: did nomad-memory's search put the evidence in its top 10? No model in the loop,
no API key, no reranker. This is not QA accuracy (whether a model then answers correctly); the
harness for that exists but hasn't been run with a grader yet. Methodology, subsets and
caveats: [BENCHMARKS.md](../BENCHMARKS.md). Result files: [`benchmarks/results/published/`](../benchmarks/results/published).

Measured 2026-11-20 on an AMD Ryzen 7 9800X3D (16 threads, 31 GB), Windows 11, Node 25, with
`Xenova/bge-small-en-v1.5` embeddings on the CPU. Several runs shared the machine, so latency is
an upper bound.

| Benchmark | Questions | Runs | recall_all@5 | recall_all@10 | NDCG@10 | Read p50 / p95 | Context per query |
|---|---|---|---|---|---|---|---|
| LongMemEval S, session level | 470 (all) | 1 | 84.0% | 93.6% | 0.895 | 87 / 188 ms | 31.3K tokens |
| LongMemEval S, turn level | 120 (20 per type) | 1 | 56.7% | 69.2% | 0.603 | 142 / 293 ms | 2.9K tokens |
| LongMemEval M, session level | 120 (20 per type) | 1 | 74.2% | 79.2% | 0.724 | 176 / 422 ms | 32.8K tokens |
| LongMemEval M, turn level | 12 (2 per type) | 1 | 58.3% | 66.7% | 0.594 | 555 / 768 ms | 2.8K tokens |
| BEAM 100K | 240 of 400 | 3 | 15.0% ±0.0 | 19.7% ±0.2 | 0.230 | 149 / 251 ms | 7.5K tokens |
| BEAM 500K (10 chats) | 124 of 200 | 1 | 9.7% | 17.7% | 0.162 | 243 / 358 ms | 6.0K tokens |
| BEAM 1M (5 chats) | 61 of 100 | 1 | 13.1% | 16.4% | 0.191 | 126 / 229 ms | 8.4K tokens |

MemoryAgentBench labels no evidence, so it is scored by whether a retrieved item contains the
gold answer (answer_hit, a weaker proxy):

| Benchmark | Questions | Runs | answer_hit@5 | answer_hit@10 | Read p50 / p95 |
|---|---|---|---|---|---|
| FactConsolidation, 6K to 64K tokens, single- and multi-hop | 600 | 3 | 54.2% ±0.0 | 60.2% ±0.0 | 278 / 578 ms |
| FactConsolidation, 262K tokens, single- and multi-hop | 200 | 1 | 53.5% | 53.5% | 543 / 657 ms |
| RULER QA (Accurate_Retrieval) | 200 | 3 | 71.3% ±0.3 | 82.5% ±0.0 | 420 / 790 ms |

On FactConsolidation the single-hop questions score 99% to 100% answer_hit@10 at every size,
and the multi-hop ones 36% (6K) falling to 7% (262K): the second hop's fact shares few words
with the question. A hit also doesn't show the newer of two conflicting facts was preferred.

How to read these:

- **recall_all@k** counts a question only when *every* evidence item is in the top k.
  recall_any@k (at least one) is in the result files too: on LongMemEval S session level it is
  95.1% and 99.2%. Earlier releases of this README quoted recall_any with abstention questions
  included; the numbers above replace those.
- **Abstention questions are excluded** from LongMemEval retrieval scoring, as in the official
  evaluation. BEAM questions that name no evidence messages (abstention, and many others) are
  left out of retrieval scoring and counted in the result files.
- **Session level vs turn level.** Session level finds the right conversation, but hands a
  model about 31K tokens to read per question. Turn level hands over about 3K, and finds all
  the evidence far less often.
- **M is the honest test.** LongMemEval M haystacks run to about 1.5M tokens, past any context
  window, and recall falls from S to M. BEAM is harder still: multi-hop, event-ordering and
  summarisation questions need many messages, and recall_all rarely gets them all.
- **Runs and variance.** LongMemEval stores one haystack per question and runs one query, so a
  run is deterministic: three runs of a 60-question sample matched exactly (standard deviation
  0, latency aside). BEAM and MemoryAgentBench run many queries against one store, so they were
  repeated where time allowed. Subsets are fixed (the first N of each type, the first N chats)
  and named in each result file.
- **Write latency** (per item, embedding plus its share of a batched store write) ran from
  6 ms p50 for one-line facts to 107 ms p50 for 2,000-character sessions; each result file
  has its own.

Numbers from other memory systems are not listed: we haven't measured them under this harness,
and most publish QA accuracy, a different metric.

## How It Works

### The Search Pipeline

This is where the interesting stuff happens. A query goes through nine stages before results come back.

**Stage 1: Signal Extraction.** Before any search happens, the query gets parsed for dates, entities (proper nouns), quoted phrases, and temporal language. If someone writes "What was Matt working on before he switched jobs in June?" the system extracts the date (June), the entity (Matt), and flags it as a temporal inference query because of the word "before."

**Stage 2: Vector Search.** Standard ANN search against LanceDB using cosine distance on 384-dim embeddings. This handles the "find semantically similar stuff" part. Candidates must clear a similarity floor calibrated per model family (0.42 for the default bge-small, 0.25 for MiniLM-class models) — floors live in the model profile in `src/llm.ts` and the `tests/alien-query-floor.test.ts` calibration suite keeps them honest.

**Stage 3: BM25 Keyword Scoring.** Each memory gets a BM25 score against the query: rare terms count more than common ones, a term that appears several times counts more than once (with diminishing returns), and long memories are discounted. Words are stemmed, so "visited" matches "visit". Proper nouns get an extra 1.5x boost. The keyword ranking is fused with the vector ranking by reciprocal rank.

A long memory is stored as pieces, and search returns only its best-matching piece, so one memory can't fill the results.

**Stage 4: Bonus Factors.** Every candidate gets adjustments for recency, recall frequency, tier, importance, and cognitive layer. Procedural memories (rules about how you want things done) get a small boost because they tend to be more immediately useful.

**Stage 5: Temporal Boost.** If the query mentions dates, memories get boosted based on whether they contain matching date strings or were created near the query date. Exact date matches in content get up to +0.4, timestamp proximity up to +0.3.

**Stage 6: Time-Window Retrieval.** This is the big one for temporal inference. When the system detects temporal signals, it pulls memories from the relevant time period into the candidate pool regardless of semantic similarity. "Where was I working in March 2024?" needs memories *from* March 2024, not just memories that happen to mention the word "March." Window size adapts to date precision. A specific day gets +/- 3 days, a month gets the full month plus buffer, a year gets the full year. If the query says "before March," the window extends 90 days earlier.

**Stage 7: Knowledge Graph Lookup.** When entities and time are both present, the system queries the knowledge graph for facts that were valid at the query time. If there's a triple like `(Matt, works-at, Acme Corp, valid 2024-01 to 2024-06)` and the query asks about Matt in March 2024, memories mentioning "Acme Corp" get boosted.

**Stage 8: Spreading Activation.** Based on [Collins & Loftus (1975)](https://en.wikipedia.org/wiki/Spreading_activation). The top 5 scoring memories activate their graph neighbors, which in turn activate their neighbors. Two hops deep, with activation decaying at each hop. Temporal edges get a 1.5x multiplier when the query involves time reasoning.

**Stage 9: Token Budget.** Results get sorted by score and trimmed to fit within a configurable token budget (default 1500 tokens). This prevents context bloat when injecting memories into prompts.

### Memory Tiers

Memories flow through four tiers with automatic promotion and demotion, plus a fifth scratch tier that sits outside the lifecycle:

```
scratch (24h, never promoted, manual promote only)

daily (2 days) --> short-term (14 days) --> long-term (90 days) --> archive
                        ^                                             |
                        +------ reactivation (if recalled) -----------+
```

Promotion isn't just about age. A memory moves to long-term if it's been recalled multiple times, has high importance, received "helpful" feedback, or is a procedural rule. Memories that keep getting recalled stay promoted. Memories that never get touched decay and eventually archive.

**Scratch tier** is for exploratory, session-only notes that you may want to discard. Pass `tier: 'scratch'` to `engram-ingest` and the chunk is excluded from every consolidation path: no promotion, no merging, no decay-to-archive, no linking. After 24 hours scratch chunks are auto-purged. Use `engram-scratch-promote` to graduate one to short-term once you've decided it's worth keeping.

### Memory Origin

Every chunk carries an `origin` tag that distinguishes user-asserted memory from auto-derived memory:

- **`user`** — written explicitly via `engram-ingest`. Treated as canonical user-territory: the consolidator never auto-merges, near-duplicate-deletes, or archives these. Importance still decays normally, but the content and lifecycle stay sacred.
- **`extracted`** — pulled from a conversation by `engram-extract` or the Mem0 provider.
- **`imported`** — bulk-loaded via `engram-import`.
- **`derived`** — produced by consolidation (e.g. episodic-to-semantic summaries).

The split mirrors the journal pattern in [przm Voice](https://github.com/OneNomad-LLC/przm-voice) (persona): a clean ownership boundary between what the user said and what the system inferred. If you want auto-extracted memories to lose to your hand-written ones in a near-duplicate fight, this is what makes that happen.

Importance decays exponentially over time, but the rates differ by cognitive layer:
- **Procedural** (rules): decays slowest (0.98/week, floor 0.15). Rules tend to stay relevant.
- **Semantic** (facts): medium decay (0.97/week, floor 0.10)
- **Episodic** (events): decays fastest (0.95/week, floor 0.05). Specific moments matter less over time.

### Cognitive Layers

Every memory gets classified into one of three layers:

- **Episodic** is for events tied to a specific moment. "User debugged a schema migration and it took most of the session."
- **Semantic** is for durable facts. "User prefers TypeScript over Python." "User's dog is named Ellie."
- **Procedural** is for behavioral rules about how the user wants things done. "Always show code before explanation." "Never use em-dashes."

The system can extract these from conversations using LLM-powered classification or, if no API key is available, a set of heuristic patterns. The heuristics catch things like "I always prefer X" (procedural), "I work at Y" (semantic fact), and "no, don't do that" (correction/procedural).

### Procedural Rules

Learned from user corrections and direct instructions. Each rule has a confidence score that shifts with evidence:

- Reinforcement (user repeats or confirms the rule): confidence +0.1
- Contradiction (user does the opposite): confidence -0.2

The asymmetry is intentional. Contradictions should weigh more because they often mean the rule was wrong. Rules that hit zero confidence get pruned.

### Knowledge Graph

Entity-relationship triples with temporal validity. Each triple records when a fact became true and optionally when it stopped being true.

```
("Matt", "works-at", "Acme Corp",  validFrom: 2024-01, validTo: 2024-06)
("Matt", "works-at", "NewCo",      validFrom: 2024-06, validTo: null)
("finch-core", "uses", "TypeScript", validFrom: 2025-01, validTo: null)
```

When a fact changes, the old triple gets invalidated (marked with an end date) and a new one gets created. The full history is preserved so the system can answer questions about the past. Adding a triple that already exists just bumps its confidence score.

### Reconsolidation

Borrowed from neuroscience. When a memory gets recalled during a relevant conversation and marked as helpful, the system can update it with new context. A memory like "User prefers TypeScript" might get refined to "User prefers TypeScript for large projects but uses Python for quick scripts" if that nuance comes up in conversation.

This only triggers if the memory hasn't been reconsolidated in the last 24 hours (to prevent over-updating) and requires an LLM API key. Memories with `origin: user` are never rewritten: what the user said stays in their words.

### Procedural rules

Rules are extracted from correction and preference memories and carry a **scope**: empty means the rule is about how the user works and applies everywhere; otherwise it is the slug of the project the memory was ingested under. Session-start context and `formatRulesForPrompt` only show a project's rules inside that project, which is what stopped a Stave copy rule from appearing in every session.

Without an LLM key, extraction is a directive gate rather than a keyword match. A sentence has to read as an instruction: it starts with one, after an optional label such as "Rule from Matt:" and an optional scoping clause such as "In the DB7001 workflow, ...". The old extractor fired on any sentence containing "always" or "never", which turned narrative like "the fix was never half-applied" into a standing rule and split one long memory into half a dozen rows. Restatements now reinforce the existing rule instead of adding another: the match compares content words with dates, quotes and names removed, and accepts either strong overlap or the shorter rule sitting mostly inside the longer one.

The table is meant to be a function of the chunks and the extractor, so when the extractor changes the table can be re-derived rather than hand-pruned:

```
nomad-memory-mcp rules list [--scope <slug>]
nomad-memory-mcp rules rebuild
```

`rebuild` deletes every rule, clears the one-shot backfill marker, and replays the correction and preference chunks grouped by project so each rule takes the scope of the memory it came from. When a memory carries no domain but its label names a project the store already knows ("Stave-admin workflow rule:"), the rule is scoped from the label, and that label carries forward to the memory's later sentences. A rule's starting confidence is seeded from the importance of the memory it came from, so a rule from a 0.95 correction starts above one from a passing note rather than every rule sitting level at 0.5; old memories have decayed, so the session-start display floor is 0.35 rather than 0.5.

Known gap: the chunker splits long memories at sentence boundaries with the same naive rule the old extractor used, so a memory can be stored cut at "e.g." or inside a parenthesis. The extractor refuses to mint a rule from text that is visibly cut, but the underlying chunk stays cut until the chunker learns the same abbreviations. Rules imported from the Voice bridge are recreated on the next maintenance pass, and the bridge only reinforces a rule when the bridge entry is newer than the rule's last update, so an unchanged file cannot inflate confidence pass after pass.

### Repairs and history

`nomad-memory-mcp grade --all` grades every Claude Code transcript on the machine and records the outcomes, so a store that predates inferred outcomes gets its history back. On this machine: 210 transcripts, 158 searches, 513 helpful and 745 irrelevant chunk outcomes, four minutes, no parser failures.

`nomad-memory-mcp repair [--dry-run]` fixes three things the measurements found. A long memory is stored as a whole parent plus child pieces, and the chunker used to cut those pieces at "(e.g." or inside a backticked command with the same naive rule the extractor had; the parent always held the whole text, so nothing was lost, but the cut pieces were noise. `repair` re-ingests such memories from their whole text through the normal path, embedded fresh and re-pieced with the fixed splitter. Derived consolidation summaries that the old heuristic cut mid-word ("Careers and Oil Ch") are trimmed to their last whole sentence, or deleted when none remains. And corrections and preferences the user stated explicitly are lifted to the instruction floor the consolidator now keeps them at: a rule the user set does not become less true with age, and 314 of them had decayed to 0.15 and were losing retrieval to passing notes.

A long memory is stored whole as a parent and again as child pieces, and the pieces are what retrieval finds. On a golden set of 24 paraphrased questions against this store, with a hit counted on the target, its parent or a sibling piece, recall at 5 was 0.79 with pieces and 0.33 with parents alone; raising the split threshold was tried and reverted for that reason. After the repairs, the instruction floor and the outcome backfill, the same questions on a fresh copy scored recall at 1 0.50, at 5 0.83, at 10 0.92, mean reciprocal rank 0.64, up from 0.42, 0.79, 0.88 and 0.58.

### Session-start context

Rules and handoffs only helped when the agent remembered to ask for them, and measured over a day it did not: a rule written at importance 0.95 in the morning was never queried that afternoon, and the mistake it described was made again. So the store pushes instead of waiting to be pulled.

The `SessionStart` hook runs `nomad-memory-mcp context` and Claude Code adds its output to the session before the first message. Four sections, each capped and the whole capped at about 10k characters: the latest handoff or the crash checkpoint if that is newer, the standing procedural rules by confidence, the corrections and preferences with high importance, and memories whose domain matches the working directory's name. No LLM. If the store is unreachable it prints nothing, because a memory problem must never block a session.

### Recall Outcomes

A feedback loop that lets the system learn which memories are actually useful:

- **Helpful**: importance +0.05, triggers reconsolidation, strengthens graph edges to co-recalled memories
- **Corrected**: importance -0.10 (memory was wrong)
- **Irrelevant**: importance -0.05

If a memory gets marked irrelevant 3+ times out of the last 5 recalls, its importance drops sharply and it may get archived.

#### Inferred outcomes

`memory-outcome` is still there, but the loop no longer depends on an agent remembering to call it, because agents do not. Measured over one working session: five searches, seven ingests, zero outcomes recorded. Everything downstream of that signal was starved.

The stop hook now grades searches mechanically from the Claude Code transcript, with no LLM. Once a `memory-search` result has had a few assistant turns to prove itself, each returned chunk is checked against everything the assistant said or did afterwards. Distinctive material counts: a file path or an id on its own, two code identifiers, a few numbers or proper nouns. Enough of that and the chunk is recorded **helpful**; none of it and it is **irrelevant**. The session-end hook grades whatever is left with no wait. Each search is graded once, tracked per session under `<dataDir>/outcomes/`.

Two limits, stated plainly. It never infers **corrected**, because a substring check cannot tell a wrong memory from an unused one, so that stays an explicit call. And an assistant that quotes a search result back without acting on it reads as helpful. The signal that matters most is the negative one: until this, nothing was ever marked irrelevant at all, so every memory ever returned looked equally good.

Run it by hand to see what it would do:

```
nomad-memory-mcp grade --transcript ~/.claude/projects/<project>/<session>.jsonl --session <id> --final --dry-run
```

### Knowledge Graph Auto-Population

When a memory is ingested, the system heuristically extracts entity-relationship triples and adds them to the knowledge graph automatically. It detects 12 relationship types including `works-at`, `uses`, `depends-on`, `prefers`, `chose`, `located-in`, and more. This means the knowledge graph grows passively as memories accumulate, without needing explicit `engram-kg-add` calls for every fact.

### Governance Middleware

Advisory checks that flag potential issues without auto-deleting anything:

- **Contradiction detection**: Combines vector similarity, keyword heuristics, and optional LLM analysis to find memories that conflict with each other. Flags them for review.
- **Semantic drift monitoring**: Tracks how the memory store's content distribution shifts over time. Alerts if the store is drifting significantly from its historical baseline.
- **Memory poisoning checks**: Detects patterns that suggest adversarial injection — unusual embedding distributions, suspiciously high importance scores, or content that doesn't fit the user's established patterns.

### Adaptive Forgetting

Inspired by [FadeMem (Jan 2026)](https://arxiv.org/abs/2501.xxxxx). Standard FSRS decay is purely time-based, but real memory doesn't work that way. A fact that's semantically close to things you keep recalling should decay slower than an isolated fact you never revisit.

Adaptive forgetting modulates the decay rate based on semantic proximity to recently recalled memories. If a memory's nearest neighbors are getting recalled, it decays slower. If nothing nearby is ever accessed, it fades faster. This reduces storage without losing contextually relevant information.

### Self-Organizing Memories

During consolidation, the system does two passes of housekeeping beyond decay and promotion. First, any memory missing a short description gets one auto-generated from its content, which makes it easier to surface in summaries and the knowledge graph. Second, the consolidator scans for semantically related memories that aren't yet linked and generates cross-links between them, so spreading activation has more edges to traverse the next time a query comes in. The graph densifies passively as the store grows.

### Duplicate Detection and Merging

New memories get checked against existing ones using Jaccard similarity on word sets (threshold 0.75). If a duplicate is found, it doesn't get stored.

During consolidation, the system also scans for near-duplicates using cosine similarity on embeddings (threshold 0.9). When found, the higher-importance memory absorbs the other's recall count and the duplicate gets deleted.

### Handoff Protocol

Context compaction is irreversible, and if the window fills completely before compaction runs the user has to abandon the chat. Nomad Memory treats this as a first-class failure mode and ships three tools that mechanize the fix:

- `engram-handoff-write` persists a structured "where we left off" snapshot to `handoffs/YYYY-MM-DD_HH-MM-SS.{json,md}` — currentTask, completed, nextSteps, openQuestions, file references, decisions, and free-form notes. The JSON half is for programmatic resume; the markdown half is for humans.
- `engram-handoff-read` loads the latest handoff (or a specific one by stamp). Agents call it at session start to pick up from exactly where the previous session stopped.
- `engram-context-pressure` is a self-nudge: the agent reports its own pressure level (`ok`/`warm`/`hot`/`critical`) and gets back a deterministic action plan — when to save, when to write the handoff, when to compact early rather than riding the window to the edge. Passing `phaseBoundary=true` (task complete, pivoting focus, finishing a subsystem) overrides level and forces a proactive compact; the reasoning is that pivots thrash Anthropic's 5-minute prompt cache anyway, so eating that miss at the boundary is effectively free and avoids carrying the verbose tool output of the finished phase into the next one.

The bundled `engram_precompact_hook.sh` runs autonomously before compaction: it approves immediately if a fresh handoff from the same lane (written within the last 5 minutes) already exists; otherwise it auto-generates a mechanical handoff from the transcript (recent user messages, edited files, tool calls, commits) and approves. `/compact` "just works" — no two-step ritual.

#### Lanes and handoffs between sessions

One machine can run Claude Code under more than one config directory, a personal `~/.claude` and a work `~/.claude-work` for example, and all of those sessions share one store. Before 1.6.0 they also shared one crash checkpoint and one "latest handoff", so a work session could open on a personal session's work and the other way round.

A session's lane is the name of its config directory: `~/.claude` is `claude`, `~/.claude-work` is `claude-work`, and `NOMAD_MEMORY_LANE` overrides it. Handoffs record the lane and project (working directory name) they were written in. Session start, `memory-handoff-read`, `memory-handoff-list` and the pre-compact hook only see the session's own lane, preferring the current project; pass `lane` or `all` to look elsewhere. Handoffs written before 1.6.0 carry no lane and are left out. The stop hook keeps one checkpoint per session under `handoffs/checkpoints/` instead of one shared file.

A handoff can also be sent to another lane. `memory-handoff-write` with `to: "claude-work"` (or `nomad-memory-mcp handoff send --to claude-work --task "..."` from a shell) puts it in that lane's inbox instead of saving it as the sender's resume note. Sessions in that lane see it at session start and, with the user-prompt hook installed, on their next prompt if it arrives mid-session. Each session is told about a handoff once. The session is told to treat it as a request and confirm with the user before acting; `memory-handoff-inbox` lists pending ones and `memory-handoff-ack` marks one picked up. Messages land at a turn boundary: nothing wakes an idle session.

#### Installing the hooks

Nomad Memory ships five optional Claude Code hooks, all bash:

- `hooks/engram_sessionstart_hook.sh` (SessionStart): prints the inbox, the latest handoff or checkpoint from the lane, rules, corrections and project memories
- `hooks/engram_userprompt_hook.sh` (UserPromptSubmit): announces handoffs addressed to the lane that arrived since the session was last told
- `hooks/engram_stop_hook.sh` (Stop): writes the session's rolling checkpoint and grades recall
- `hooks/engram_precompact_hook.sh` (PreCompact): writes a compact-time handoff unless a fresh one exists
- `hooks/engram_sessionend_hook.sh` (SessionEnd): final recall grading

Wire them in `~/.claude/settings.json` (or your project's `.claude/settings.json`), and in every other config directory whose sessions should share the store:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash /absolute/path/to/nomad-memory/hooks/engram_sessionstart_hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash /absolute/path/to/nomad-memory/hooks/engram_userprompt_hook.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash /absolute/path/to/nomad-memory/hooks/engram_stop_hook.sh" }] }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "bash /absolute/path/to/nomad-memory/hooks/engram_precompact_hook.sh" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "bash /absolute/path/to/nomad-memory/hooks/engram_sessionend_hook.sh" }] }
    ]
  }
}
```

Use the absolute path to the hook script — Claude Code does not resolve relative paths from your project root. On Windows, the hooks require WSL or Git Bash on PATH (they're bash scripts); native PowerShell is not supported.

The hooks are optional. The MCP tools work without them. The hooks just make the handoff lifeline reliable across `/compact` and session end without requiring you to remember to call `memory-handoff-write` manually.

## Compatibility

Nomad Memory is an MCP (Model Context Protocol) server. It works with any client that supports the MCP standard. That includes:

- **Claude Code** (Anthropic's CLI and desktop app)
- **Claude.ai** (via MCP server configuration)
- **Cursor** (AI code editor)
- **Windsurf** (AI code editor)
- **Cline** (VS Code extension)
- **Continue** (VS Code / JetBrains extension)
- **Any MCP-compatible client** (the protocol is open and standardized)

If your tool can connect to an MCP server over stdio, Nomad Memory will work with it.

## Installation

> **Heads up — `@onenomad/nomad-memory` publishes at v1.0.** The package isn't on npm yet. Until v1.0 lands, install from source (see [Source](#source) below). The `npx @onenomad/nomad-memory` commands shown in this section will work after the v1.0 publish; nothing else changes about the install steps.

### Claude Code

```bash
claude mcp add engram -- npx @onenomad/nomad-memory
```

### Claude Desktop

Add to your Claude Desktop config file. On macOS it's at `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/nomad-memory"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Any MCP Client (Cursor, Windsurf, Cline, etc.)

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/nomad-memory"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/OneNomad-LLC/nomad-memory.git
cd nomad-memory
npm install
npm run build
```

Then point your MCP client at `dist/server.js`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/server.js"]
    }
  }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NOMAD_MEMORY_LLM_PROVIDER` | (none) | `claude-cli` (also `claude-subscription`) runs completions through the Claude Code CLI signed in on this machine, so they use your Claude subscription instead of an API key. It runs `claude -p` with no tools, no MCP servers and `--safe-mode` (no hooks), so it can't call back into nomad-memory. `NOMAD_MEMORY_LLM_MODEL` takes CLI names (`haiku`, the default, or `sonnet`); `NOMAD_MEMORY_CLAUDE_CLI` sets the CLI's path if `claude` isn't on PATH. |
| `NOMAD_MEMORY_LLM_BASE_URL` | OpenRouter | Any OpenAI-compatible endpoint for LLM features: a local Ollama, LM Studio or vLLM server (no key needed), a provider's own OpenAI-compatible API, or a proxy. Legacy `ENGRAM_LLM_BASE_URL` also honored. |
| `NOMAD_MEMORY_LLM_API_KEY` | (none) | Key for that endpoint. `OPENROUTER_API_KEY` also works. With neither a key nor a custom endpoint, the system uses heuristic extraction and keyword/vector search only. |
| `MEM0_API_KEY` | (none) | Enables Mem0 cloud extraction as a second opinion |
| `NOMAD_MEMORY_DATA_DIR` | `~/.claude/nomad-memory` | Where data gets stored (legacy `PRZM_MEMORY_DATA_DIR` and `ENGRAM_DATA_DIR` also honored; an existing `~/.claude/przm-memory` is kept when there is no new directory). |
| `NOMAD_MEMORY_EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | HuggingFace model for embeddings (legacy `ENGRAM_EMBEDDING_MODEL` also honored). After changing it, run `nomad-memory-mcp reembed` — stored vectors stay in the old model's space until re-embedded, and the server warns at boot when they mismatch. |
| `NOMAD_MEMORY_ENABLE_CROSS_ENCODER_RERANK` | `0` | Set `1` to rerank the top 30 results with a local cross-encoder (`NOMAD_MEMORY_RERANK_MODEL`, default `Xenova/ms-marco-MiniLM-L-6-v2`, downloaded on first use). About 3 points better ranking on short memories for about 150 ms a search. |
| `NOMAD_MEMORY_AUTO_MAINTAIN` | `1` | Set `0` to disable the automatic consolidation pass (runs ~20s after boot when the last run is older than the interval). One pass runs at a time across every session sharing the data directory (`maintenance.lock`). |
| `NOMAD_MEMORY_MAINTAIN_INTERVAL_HOURS` | `24` | Minimum hours between automatic consolidation passes. |
| `NOMAD_MEMORY_REDACT_SECRETS` | `1` | Set `0` to store text without redacting credentials (see [Secrets](#secrets)). |
| `ENGRAM_DEVICE` | `cpu` | Embedding device: `cpu`, `dml` (DirectML), or `cuda` |
| `NOMAD_MEMORY_LLM_MODEL` | `anthropic/claude-haiku-4.5` | Model for LLM features, in the endpoint's naming (any model on [openrouter.ai](https://openrouter.ai) by default). Legacy `ENGRAM_MODEL` also honored. |
| `NOMAD_MEMORY_MODEL_DIR` | library default | Where the embedding model is cached. Without it the library's cache inside `node_modules` is used while writable, else `~/.cache/nomad-memory/models`. The boot log prints the path in use. |
| `STORAGE_BACKEND` | `file` | Storage backend: `file` (LanceDB + filesystem, default), `postgres` (self-hosted multi-tenant), or `cloud` (przm Cloud Pro). See below. |
| `DATABASE_URL` | (none) | Postgres connection string. Required when `STORAGE_BACKEND=postgres`. |
| `TENANT_ID` | (none) | Tenant identifier — every row in postgres is scoped by this. Required when `STORAGE_BACKEND=postgres`. |
| `PYRE_API_URL` | (none) | przm server URL for `nomad-memory login`. Alternative to the positional arg or `--server` flag — one of the three is required. |
| `PYRE_API_KEY` | (none) | przm Cloud API key. Overrides the field from `~/.pyre/credentials.json` when set. |
| `PYRE_CREDENTIALS_FILE` | `~/.pyre/credentials.json` | Override the credentials-file path (CI / headless installs). |
| `ENGRAM_NO_AUTO_CLOUD` | (unset) | Truthy (`1`/`true`/`yes`/`on`) suppresses the credentials-file probe so `~/.pyre/credentials.json` is ignored even when present. Use for benchmarks, CI, or anywhere you want to guarantee local file mode without deleting the file. Explicit `STORAGE_BACKEND` always wins. |

### Hosted (przm Cloud)

For przm Cloud Pro users:

```bash
npm install -g @onenomad/nomad-memory
nomad-memory login https://przm.sh
```

`login` requires the przm server URL. The binary ships with no hardcoded default — you point at whichever przm instance you're using (prod, staging, your own deployment). Three equivalent ways to supply it:

```bash
nomad-memory login https://przm.sh          # positional argument
nomad-memory login --server https://przm.sh # flag
PYRE_API_URL=https://przm.sh nomad-memory login   # env var
```

`login` opens that URL in your browser, shows you a one-time pairing code, and waits for you to approve the device. On approval it writes `~/.pyre/credentials.json` (mode 0600) using the canonical `api_url` from the server's response — which may differ from the login URL you typed if the server normalises or redirects. From that point on Nomad Memory automatically routes through your cloud instance. Local data stays local; nothing changes for users who don't run `login`.

```
$ nomad-memory login https://przm.sh
Open this URL in your browser to authorize:

  https://przm.sh/connect

Enter this code when prompted: PYRE-7K4M-9N2X
(waiting for approval — Ctrl+C to cancel)
Logged in. Credentials saved to ~/.pyre/credentials.json.
```

To sign out:

```bash
nomad-memory logout
```

This deletes `~/.pyre/credentials.json` and reverts to local file mode on the next run. Idempotent — running it when you're already logged out exits 0.

**Where credentials live**

Credentials are stored at `~/.pyre/credentials.json` with mode `0600` (readable by you only). The file is a flat JSON object with `api_url`, `api_key`, `label`, `scopes`, and `issued_at`. Override the location with `PYRE_CREDENTIALS_FILE` if you have a multi-user setup.

**Headless / CI installs**

There's no terminal to open a browser from in CI. Skip `login` and set the env vars directly:

```bash
export STORAGE_BACKEND=cloud
export PYRE_API_URL=https://przm.sh
export PYRE_API_KEY=sk_pyre_xxx
```

When `STORAGE_BACKEND` is unset, Nomad Memory probes for `~/.pyre/credentials.json` and uses cloud mode if it finds one. Explicit env vars always win. The routing decision is logged to stderr on startup (`nomad-memory: storage=cloud (auto-routed via ~/.pyre/credentials.json) · apiUrl=…`) so it's never silent — if you see a benchmark or local script hitting the wire when you expected local mode, that log line is the first place to look.

To force local file mode without deleting your credentials file (benchmarks, CI, local-only test runs against a real login), set `ENGRAM_NO_AUTO_CLOUD=1`. The probe is skipped, the credentials file is left alone, and the routing log line names the opt-out so it's visible to whoever inherits the environment.

The existing `STORAGE_BACKEND=postgres` self-host path (below) is unaffected — none of this changes anything for users running their own postgres instance.

### Cloud / multi-tenant mode

By default Nomad Memory stores everything locally under `ENGRAM_DATA_DIR` (LanceDB tables for chunks/daily_logs/rules/knowledge_triples, plus markdown files for diary and handoffs). For a single user on a single machine this is the right answer — fast, offline, zero dependencies.

For shared/cloud deployments where many users share one process, it also speaks postgres with [pgvector](https://github.com/pgvector/pgvector).

1. Provision a postgres database with the `vector` extension available.
2. Set environment variables:

   ```bash
   export STORAGE_BACKEND=postgres
   export DATABASE_URL=postgres://user:pass@host:5432/engram
   export TENANT_ID=<one-id-per-user>
   ```

3. Install the postgres driver (it's an `optionalDependency`, so file-mode users don't pull it in):

   ```bash
   npm install pg
   ```

4. Run the schema migrations against the database once:

   ```bash
   DATABASE_URL=postgres://... npx engram-migrate
   ```

   This creates the six tables (`chunks`, `daily_logs`, `rules`, `knowledge_triples`, `diary_entries`, `handoffs`), enables the `vector` extension, and adds the hot-path indexes (per-tenant created_at, ivfflat on chunks.embedding, etc.). The runner is idempotent — re-running is a no-op for already-applied files.

5. Boot Nomad Memory normally. Every query is scoped by `TENANT_ID`; switching tenants is just a different env var on a different process.

**Notes**

- pgvector required (`CREATE EXTENSION vector;`). The migration runs this for you when your DB role has the privileges; otherwise create it manually first.
- Embedding dimension is 384 by default (matches the local `Xenova/bge-small-en-v1.5` model). If you change `NOMAD_MEMORY_EMBEDDING_MODEL` to one with a different dimensionality, edit `migrations/postgres/001_init.sql` before running migrations.
- Local file mode and postgres mode are **not** wire-compatible — there's no auto-import. If you're migrating an existing local install to the cloud, re-ingest is the path. Diary and handoffs in particular store different on-disk formats (markdown files vs. jsonb rows).
- Single user, single machine: stay on `file`. The postgres path exists for the hosted przm deployment and similar shared infra.

## Tools

The MCP server exposes 31 tools across six groups. Several earlier tools (`engram-format`, `engram-check-duplicate`, `engram-extract-rules`, `engram-taxonomy`, `engram-kg-stats`) were folded into their parent tools in 1.0.0-beta.6 — pass the relevant flag or mode to the parent instead. 1.0.0-beta.8 added the Handoff tools for cross-session continuity. 1.0.0 adds the memory origin field (user vs derived), the scratch tier, and `memory-scratch-promote`.

> **Backward compatibility:** tools were renamed from `engram-*` to `memory-*` in v1.0.0-beta.7. As of 1.3.0 the `engram-*` aliases are opt-in: set `NOMAD_MEMORY_LEGACY_ALIASES=1` to register them. They double the tool surface every MCP client pays for, so leave them off unless an old config still calls `engram-*` names. They will be removed in v2.

### Core Memory

| Tool | What it does |
|------|-------------|
| `memory-search` | Hybrid ANN + keyword search with spreading activation. Supports a formatted output mode for prompt injection (replaces the old `engram-format`). |
| `memory-ingest` | Write-ahead log: immediately persist a memory before responding. Runs duplicate detection inline (replaces `engram-check-duplicate`). Defaults `origin='user'` since explicit ingest is user-asserted; pass `tier: 'scratch'` for session-only notes. |
| `memory-scratch-promote` | Graduate a scratch-tier memory to short-term so it survives the 24h auto-purge and enters the normal consolidation lifecycle. |
| `memory-extract` | Extract memories from a conversation (LLM or heuristic). Rules-only mode replaces the old `engram-extract-rules`. |
| `memory-maintain` | Run consolidation (decay, promote, link, merge, self-organize). Auto-describes unnamed memories, generates cross-links, and syncs the Persona procedural bridge when both servers are running. Also runs automatically: the server schedules a pass ~20s after boot whenever the last run is older than `NOMAD_MEMORY_MAINTAIN_INTERVAL_HOURS` (default 24h). |
| `memory-rules` | Show active procedural rules |
| `memory-outcome` | Record recall feedback (helpful/corrected/irrelevant) |
| `memory-session` | Manage session state (hot RAM scratchpad) |
| `memory-stats` | Memory statistics by tier, layer, type. Includes KG stats, domain/topic taxonomy, and Persona bridge status (replaces `engram-kg-stats` and `engram-taxonomy`). |

### Knowledge Graph

| Tool | What it does |
|------|-------------|
| `memory-kg-add` | Add a subject-predicate-object triple |
| `memory-kg-query` | Query triples with optional filters |
| `memory-kg-invalidate` | Mark a fact as no longer valid |
| `memory-kg-timeline` | Get chronological history of an entity |

### Diary

| Tool | What it does |
|------|-------------|
| `memory-diary-write` | Write a session diary entry |
| `memory-diary-read` | Read diary entries by date or range |

### Handoff (cross-session continuity)

| Tool | What it does |
|------|-------------|
| `memory-handoff-write` | Structured "where we left off" snapshot — currentTask, completed, nextSteps, openQuestions, fileRefs, decisions, notes. Written before compaction or session end so a fresh session can resume without re-explanation. Tagged with the session's lane and project; pass `to` to send it to another lane's inbox instead. |
| `memory-handoff-read` | Load the latest handoff from the session's lane, same project first (or one by name or stamp; `lane` or `all` to look outside the lane). Call at session start to pick up where the prior session left off. |
| `memory-handoff-list` | Recent handoffs in the lane, newest first, with stamp, reason, name and any `to`. |
| `memory-handoff-inbox` | Handoffs other sessions addressed to this lane that nobody has picked up. |
| `memory-handoff-ack` | Mark a handoff addressed to this lane picked up. |
| `memory-context-pressure` | Self-assess context window pressure (`ok`/`warm`/`hot`/`critical`) and receive a deterministic action plan — when to save memories, when to write a handoff, when to invoke `/compact`. Pass `phaseBoundary=true` at natural task/phase boundaries to force a proactive compact regardless of level (pivots thrash the cache anyway — compacting at the boundary is a free lunch). |

### Governance

| Tool | What it does |
|------|-------------|
| `memory-govern` | Run governance checks: contradiction detection (vector + heuristic + LLM), semantic drift monitoring, and memory poisoning detection. All advisory — flags issues without auto-deleting. |

### Import

| Tool | What it does |
|------|-------------|
| `memory-import` | Bulk import from Claude Code JSONL, ChatGPT JSON, or plain text |

## Slash Commands

These work in any MCP-compatible client (Claude Code, Cursor, etc.). `/onboard` is a real MCP prompt the server registers, so it shows up as a slash command automatically with no install. The rest are advertised in the MCP server instructions and are also shipped as `.claude/commands` files (see below) for clients that discover commands from the filesystem.

| Command | What it does |
|---------|-------------|
| `/onboard` | **Fresh-install setup.** Interviews you for your durable rules and preferences (identity/attribution, emails, communication style, code + workflow conventions, hard rules, project scoping) and stores each as a procedural memory that persists and auto-loads every session — syncing into tone too when przm-voice is connected. Built in as an MCP prompt, so it needs no install and appears automatically once the server is connected. Re-run anytime to add more. |
| `/memory-source <engram\|off\|hybrid>` | Switch memory backend. "engram" uses Nomad Memory exclusively, "off" disables all persistent memory, "hybrid" runs Nomad Memory alongside native client memory. |
| `/recall <query>` | Search memories using the full hybrid pipeline (vector + keyword + temporal + KG + spreading activation). Results presented conversationally. |
| `/forget <what>` | Find and remove or correct specific memories. Shows matches and confirms before acting. |
| `/memory-health [maintain]` | Show memory system stats (tiers, layers, rules, KG size). With "maintain", runs the full consolidation cycle. |
| `/memory-api <key>` | Set or update the OpenRouter API key that unlocks LLM extraction, reranking, and procedural-rule learning. |
| `/knowledge <subcommand>` | Knowledge graph operations. Subcommands: `timeline <entity>`, `about <entity>`, `add <s> <p> <o>`, `correct <s> <p>`, `stats`. |
| `/memory <subcommand>` | Quick ops. Subcommands: `save <content>`, `diary [date]`, `diary write <entry>`, `import <source>`, `rules`, `session [show\|clear]`. |

### Installing Slash Commands for Claude Code

The slash commands above are advertised in the MCP server instructions and work automatically in most clients. For Claude Code specifically, you can also install them as custom commands so they show up in the `/` command menu:

```bash
# From the engram directory
bash install-commands.sh

# To overwrite existing commands
bash install-commands.sh --force
```

This copies command files to `~/.claude/commands/` where Claude Code picks them up globally. After installing, type `/` in Claude Code to see them in the command list.

## Architecture

```
Conversations --> Extract --> LanceDB (vectors + metadata)
                    |                       |
              KG Auto-Populate   +----------+----------+
              (12 rel types)     |          |          |
                            Vector ANN  IDF Keywords  Time Windows
                                 |          |          |
                                 +----+-----+-----+----+
                                      |           |
                                 KG Temporal   Spreading
                                   Lookup     Activation
                                      |           |
                                      +-----+-----+
                                            |
                                      Score + Rank
                                            |
                                    Token Budget Cap
                                            |
                                   Governance Checks
                                   (advisory, async)
                                            |
                                   Format for Prompt

                         Adaptive Forgetting
                    (semantic proximity modulates decay)
                                  |
              Persona Bridge <--> Procedural Rules
              (emotion-weighted    (confidence-scored,
               importance,          learned from
               cognitive load)      corrections)
```

### Data Storage

Everything lives locally:

```
~/.claude/engram/
├── SESSION-STATE.md      # Hot RAM scratchpad
├── diary/                # Daily diary entries
│   └── YYYY-MM-DD.md
├── handoffs/             # Cross-session "where we left off" snapshots
│   ├── YYYY-MM-DD_HH-MM-SS.json
│   ├── YYYY-MM-DD_HH-MM-SS.md
│   ├── checkpoints/      # One rolling crash checkpoint per session
│   │   └── <session-id>.json
│   └── announced/        # Which inbox handoffs each session has been told about
│       └── <session-id>.json
└── lance/                # LanceDB tables
    ├── chunks.lance/     # Memory chunks with embeddings
    ├── daily_logs.lance/ # Extraction logs
    ├── rules.lance/      # Procedural rules
    └── knowledge_triples.lance/
```

### Dependencies

- **LanceDB** for the embedded vector database, handles ANN search natively
- **@huggingface/transformers** for local embedding inference (Xenova/bge-small-en-v1.5 by default, 384 dimensions, ~34MB; swap models with `NOMAD_MEMORY_EMBEDDING_MODEL` + `nomad-memory-mcp reembed`)
- **openai** (optional) for LLM-powered extraction and reranking via OpenRouter
- **mem0ai** (optional) for Mem0 cloud extraction
- **@modelcontextprotocol/sdk** for the MCP server protocol

## Benchmarks

Clone, install, fetch the open datasets, run:

```bash
git clone https://github.com/OneNomad-LLC/nomad-memory.git
cd nomad-memory
npm install
bash benchmarks/download-datasets.sh          # LongMemEval S, BEAM, MemoryAgentBench
bash benchmarks/download-datasets.sh lme-m    # LongMemEval M, 2.7 GB
npm run bench:longmemeval                     # S, session level
npm run bench:longmemeval -- --variant m --per-type 20
npm run bench:beam -- --size 100K --runs 3
npm run bench:mab -- --split Conflict_Resolution --runs 3
npm run bench:all                             # LongMemEval S, BEAM 100K, FactConsolidation, operational benches
```

No API key is needed for any of these. QA accuracy needs one (`ANTHROPIC_API_KEY`) and grades
with a Claude model, so its scores are not directly comparable with numbers graded by the
official gpt-4o graders:

```bash
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode memory --runs 3
ANTHROPIC_API_KEY=... npm run bench:qa -- --benchmark lme-s --mode full-context --runs 3   # no-memory baseline
```

[BENCHMARKS.md](../BENCHMARKS.md) has the methodology, every flag, and why LoCoMo is no longer used.

### Nomad Memory synthetic suite (`bench`)

A self-contained 15-question battery covering single-fact recall, preferences, temporal reasoning, knowledge updates, and adversarial / distractor resistance. No dataset download. Exits non-zero when R@5 drops below 70%. Its scores move between runs of identical code (R@5 73% to 80%), because search bumps recall counts in the background while later questions run, so treat it as a smoke test.

```bash
npm run bench
npm run bench:verbose
```

Runtime: ~30 sec. Self-contained — runs on a clean clone with no flags.

### Ingest throughput

Pushes N synthetic chunks (default 10,000) through `wal.ingest()` and reports chunks/sec. Two modes: `cold` (fresh data dir) and `warm` (10k chunks pre-loaded). The bench waits for background side-effects to drain before stopping the clock, so the number is "fully persisted" not "queued." KG extraction is skipped to keep the bench API-key-free.

```bash
npm run bench:throughput
npm run bench:throughput -- --chunks 5000 --mode warm
```

Runtime: ~1–3 min at default settings.

### Query latency

Loads N synthetic chunks (default 10,000), runs M queries (default 1,000) sequentially, and reports p50 / p95 / p99 latency per query bucket (`short` keyword queries, `medium` single-sentence questions, `long` multi-clause questions). Wall-clock is measured around the full `search()` call — the same path `engram-search` hits at the MCP boundary.

```bash
npm run bench:latency
npm run bench:latency -- --chunks 5000 --queries 500
npm run bench:latency -- --topk 5
```

Runtime: ~2–4 min at default settings.

## Security

### Network calls

This plugin contacts exactly two services:

1. **HuggingFace Hub** for a one-time model download on first run (~34MB for the default bge-small), cached after that
2. **Mem0 API**, only when `extractionProvider` is `mem0` or `both`

If you set `NOMAD_MEMORY_LLM_API_KEY` or `OPENROUTER_API_KEY`, it contacts OpenRouter for LLM features (you pick the model provider); with `NOMAD_MEMORY_LLM_BASE_URL` it contacts that endpoint instead, which can be a model on your own machine. With `NOMAD_MEMORY_LLM_PROVIDER=claude-cli` the Claude CLI sends the text to Anthropic under your subscription. Without any of these, everything runs fully local.

No telemetry. No analytics. No phoning home.

### Secrets

Every ingest passes through a redaction step before anything is embedded or stored. Credential shapes (provider API keys, GitHub, AWS, Slack, Google and Stripe tokens, JWTs, bearer tokens, private key blocks, `password=`-style assignments and passwords in connection strings) become `[REDACTED]`. Identifiers and placeholders such as `apiKey: string` or `password="your_password"` are left alone, so memories about code stay intact. Extraction drops a candidate memory outright when it would have held a secret. Set `NOMAD_MEMORY_REDACT_SECRETS=0` to store raw text.

### Local storage

All memory data stays on disk at `~/.claude/engram/`. Nothing gets sent anywhere unless you explicitly configure an external provider.

## Use Cases

Here are some real situations where this makes a difference.

**Personal AI assistant.** The most obvious one. You talk to an AI every day and it forgets everything between sessions. Nomad Memory fixes that. It learns your preferences, remembers your projects, picks up your corrections, and builds a picture of who you are over time. Instead of re-explaining yourself every conversation, the agent just knows.

**Developer tools.** If you use Claude Code, Cursor, or any AI coding tool, the agent forgets your codebase conventions, your preferred patterns, and the decisions you've already made. Nomad Memory picks up things like "always use explicit return types" or "we deploy to Vercel, not AWS" and carries them forward. Procedural rules are built for this.

**Customer support agents.** A support bot that actually remembers a customer's history, past issues, and preferences without needing to query a CRM every time. The knowledge graph handles entity relationships ("Customer X uses Plan Y, started in March") and temporal queries let the agent reason about timelines.

**Research and note-taking.** If you use an AI to research topics over multiple sessions, Nomad Memory lets it build on previous findings instead of starting from scratch. The diary system logs what happened each session, and the search pipeline surfaces relevant prior research when you come back to a topic.

**Multi-agent systems.** Multiple agents can share the same memory store. One agent handles research, another handles coding, and they both read from and write to the same LanceDB. The MCP protocol makes this straightforward since any MCP-compatible client can connect to the server.

**Therapy / coaching bots.** Sensitive use case, but a good one. An AI that remembers what you talked about last week, tracks your goals, and notices patterns in your behavior over time. The tier lifecycle naturally keeps recent context hot while letting older sessions fade unless they stay relevant.

## Pairs Well With: przm Voice (persona)

If Nomad Memory is the brain, [przm Voice](https://github.com/OneNomad-LLC/przm-voice) (technical handle: `persona`) is the personality.

Nomad Memory handles *what* the agent remembers: facts, preferences, rules, timelines. przm Voice handles *how* the agent communicates: tone, verbosity, format preferences, and communication style. They solve different problems but work best together.

Here's why the combo matters. Nomad Memory will learn that you prefer TypeScript over Python. przm Voice will learn that you want short answers with code first and explanation after. Nomad Memory will store the fact that you got laid off last month. przm Voice will know not to bring that up casually based on the emotional context it picked up.

przm Voice tracks behavioral signals (corrections, approvals, frustrations, praise) and builds a communication profile that adapts over time. The procedural rules surface here overlaps a little ("never use em-dashes"), but Voice goes deeper into *how* the agent should talk to you specifically. Things like matching your energy level, knowing when to be terse vs. when to elaborate, and adjusting formality based on the topic.

When both servers are running, they coordinate through three mechanisms:

1. **Emotion-weighted memory importance.** Memory calls `persona_state` during ingestion to get the current emotional valence and arousal. High-arousal negative emotions boost memory importance by up to 30%. A frustrated correction gets remembered more strongly than a neutral fact.

2. **Cognitive-load-gated search.** When Voice detects cognitive overload, Memory's `engram-search` receives the load signal and returns only the top 3 high-importance memories instead of the full result set. Less noise when you're already overwhelmed.

3. **Procedural bridge.** Memory's learned rules (from corrections and instructions) and Voice's applied evolution proposals sync through a shared bridge file at `~/.claude/procedural-bridge.json`. Voice's applied proposals reinforce or create Memory rules. Memory rules become Voice proposals with semantic conflict detection against existing soul files — catches antonym pairs and value contradictions, not just exact duplicates. The bridge auto-syncs during `persona_consolidate`, and bridge health is visible via `persona_stats`.

You can run Memory without Voice and it works fine. But if you want an AI that actually feels like it knows you, not just what you've told it, but how you like to be talked to, run both.

## License

Licensed under the [Apache License, Version 2.0](../LICENSE).

Copyright (c) 2026 Matt Stvartak / OneNomad LLC.

Use it, fork it, ship it. The full terms are in the [LICENSE](../LICENSE) file.

For inquiries: **matt@onenomad.dev**
