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

Retrieval only, no model in the loop. On LongMemEval S the right sessions land in the top 10 for 93.6% of questions (recall_all@10). The harder sets are a different story: 79.2% on a sample of LongMemEval M, and under 20% on BEAM's long multi-domain chats. Methods, subsets and caveats are in [BENCHMARKS.md](BENCHMARKS.md).

## Privacy

Everything stays on your machine unless you point it at an LLM endpoint or the Claude CLI. Secrets (API keys, tokens, private keys, passwords) are redacted before anything is stored, on by default. No telemetry.

## License

Apache-2.0. See [LICENSE](LICENSE). Copyright 2026 OneNomad LLC.
