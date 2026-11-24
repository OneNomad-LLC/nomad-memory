#!/usr/bin/env node
/**
 * Nomad Memory CLI router.
 *
 * Usage:
 *   nomad-memory-mcp                                                 → run MCP stdio server (back-compat)
 *   nomad-memory-mcp search --query <q> [--project <p>] [--limit N]
 *                     [--min-relevance F] [--format json|text]
 *   nomad-memory-mcp query  [--project <p>] [--tier <t>]
 *                     [--min-importance F] [--limit N] [--format json|text]
 *   nomad-memory-mcp help
 *
 * The CLI is additive — it wraps the same search/storage primitives the
 * MCP server uses so hook scripts can pull memories without speaking
 * stdio JSON-RPC.
 */
export {};
