<p align="center"><img src="assets/logo.svg" alt="NomadBot" width="96"></p>

# Nomad Memory

Local, long-term memory for AI agents, served over MCP. By [OneNomad](https://onenomad.dev), the makers of NomadBot.

## What it is

An MCP server that lets an agent remember things between conversations: facts, preferences, corrections, timelines. It stores them on your machine (LanceDB), finds them again with hybrid search (vectors, keywords, time, a knowledge graph), and works with no API key. An LLM is optional and only improves extraction.

## Install

```bash
npm install -g @onenomad/nomad-memory
```

Needs Node 22 or newer. The old `przm-memory*` commands still work as aliases.

## Quick start

Add it to an MCP client (Claude Code, Claude Desktop, Cursor, anything that speaks MCP):

```bash
claude mcp add nomad-memory -- npx @onenomad/nomad-memory
```

```json
{ "mcpServers": { "nomad-memory": { "command": "npx", "args": ["@onenomad/nomad-memory"] } } }
```

Or use the CLI against the same store:

```bash
nomad-memory-mcp search --query "where was I working last March?"
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `NOMAD_MEMORY_DATA_DIR` | `~/.claude/nomad-memory` | Where memories are stored |
| `NOMAD_MEMORY_LLM_PROVIDER` | none | `claude-cli` uses your Claude subscription through the signed-in Claude Code CLI (no key; model defaults to `haiku`) |
| `NOMAD_MEMORY_LLM_BASE_URL` | OpenRouter | Any OpenAI-compatible endpoint (a local Ollama needs no key) |
| `NOMAD_MEMORY_LLM_API_KEY` | none | Key for that endpoint; `OPENROUTER_API_KEY` also works |
| `NOMAD_MEMORY_LLM_MODEL` | `anthropic/claude-haiku-4.5` | Model for extraction and re-ranking (`haiku` with `claude-cli`) |
| `NOMAD_MEMORY_EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | Local embedding model |
| `NOMAD_MEMORY_REDACT_SECRETS` | `1` | Set `0` to keep credentials in stored text |

The older `PRZM_MEMORY_*` names are deprecated but still read. Every other setting, the tools, the hooks and the architecture are in [docs/reference.md](docs/reference.md).

## Benchmarks

Retrieval is measured with no model in the loop. On LongMemEval S, every session a question needs is in the top 10 for 94.9% of questions, and at least one is in the top 5 for 96.8% (MemPalace reports 96.6% on that measure). Longer histories are harder: 79.2% on a sample of LongMemEval M, measured before BM25 keyword search went in, and 22.9% on BEAM's 100K-token chats.

For answer accuracy we ran 70 LongMemEval S questions, ten of each type. Claude Sonnet read the top 10 sessions Nomad Memory retrieved, and gpt-4o, the judge the benchmark specifies, marked 68 of the answers correct. A stricter Claude judge passed 65 of the same answers.

Other systems publish their own scores for the full 500 questions:

| System | LongMemEval S | Model answering |
|---|---|---|
| Nomad Memory (70-question sample) | 97.1% | Claude Sonnet |
| Mastra | 94.9% | gpt-5-mini |
| Mem0 | 94.4% | not named |
| Hindsight | 91.4% | Gemini 3 Pro |
| Supermemory | 85.2% | Gemini 3 Pro |
| Zep | 71.2% | gpt-4o |

This isn't like for like yet. Ours is a sample, and Sonnet read about 30,000 tokens a question where Mem0 reports under 7,000. The model answering also matters as much as the memory: Mastra scores 84.2% with gpt-4o and 94.9% with gpt-5-mini. Sources, methods and what we haven't run are in [BENCHMARKS.md](BENCHMARKS.md#how-this-compares).

## Privacy

Everything stays on your machine unless you point it at an LLM endpoint or the Claude CLI, and there's no telemetry. Secrets (API keys, tokens, private keys, passwords) are redacted before anything is stored; set `NOMAD_MEMORY_REDACT_SECRETS=0` to keep them.

## License

Apache-2.0; see [LICENSE](LICENSE). Copyright 2026 OneNomad LLC.
