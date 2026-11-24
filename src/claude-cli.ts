import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memEnv } from './env.js';

/**
 * Completions on the owner's Claude subscription, through the Claude Code CLI already signed in
 * on this machine (`claude -p`). Opt in with NOMAD_MEMORY_LLM_PROVIDER=claude-cli.
 *
 * The child is a plain text-in, text-out call: no tools, no MCP servers, and `--safe-mode` so it
 * loads no hooks, plugins or CLAUDE.md. That matters here: nomad-memory itself runs as Claude
 * Code hooks and an MCP server, and a child that loaded them would call back into nomad-memory.
 * NOMAD_MEMORY_CHILD=1 is a second guard the hooks check. (`--bare` would also skip hooks, but it
 * refuses subscription sign-in and only takes an API key.)
 */

const PROVIDER_NAMES = new Set(['claude-cli', 'claude-subscription', 'claude']);
const TIMEOUT_MS = 120_000;

export function usesClaudeCli(): boolean {
  return PROVIDER_NAMES.has((memEnv('LLM_PROVIDER') ?? '').trim().toLowerCase());
}

/** The CLI takes its own model names (haiku, sonnet, or a full id); an OpenRouter-style name doesn't apply. */
export function claudeCliModel(): string {
  const set = memEnv('LLM_MODEL', ['ENGRAM_MODEL', 'SMART_MEMORY_MODEL']);
  return set && !set.includes('/') ? set : 'haiku';
}

export function claudeCliArgs(model: string, systemPromptFile: string): string[] {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--system-prompt-file', systemPromptFile,
    '--tools', '',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
  ];
}

/** The reply text from `--output-format json`, or an error with the CLI's own words. */
export function parseClaudeCliOutput(stdout: string): string {
  let parsed: { result?: unknown; is_error?: unknown; subtype?: unknown };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Claude CLI gave no JSON result: ${stdout.trim().slice(0, 200) || '(empty)'}`);
  }
  if (parsed.is_error === true || typeof parsed.result !== 'string') {
    const said = typeof parsed.result === 'string' ? parsed.result : String(parsed.subtype ?? 'unknown error');
    throw new Error(`Claude CLI failed: ${said.slice(0, 300)}`);
  }
  return parsed.result;
}

// cmd.exe quoting for the Windows shell, which an npm-installed `claude.cmd` needs. Every
// argument here is ours (flags, a model name, a temp path); the prompt itself goes on stdin.
const winQuote = (arg: string) => (arg === '' ? '""' : /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

export async function claudeCliComplete(systemPrompt: string, userMessage: string, model: string = claudeCliModel()): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'nomad-memory-cli-'));
  const systemFile = join(dir, 'system.txt');
  writeFileSync(systemFile, systemPrompt, { encoding: 'utf8', mode: 0o600 });
  const command = memEnv('CLAUDE_CLI') ?? 'claude';
  const args = claudeCliArgs(model, systemFile);
  const windows = process.platform === 'win32';
  try {
    return await new Promise<string>((resolve, reject) => {
      // On Windows one pre-quoted command line through the shell, so a `claude.cmd` also runs.
      const child = spawn(windows ? [command, ...args].map(winQuote).join(' ') : command, windows ? [] : args, {
        shell: windows,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NOMAD_MEMORY_CHILD: '1' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude CLI took longer than ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Couldn't start the Claude CLI (${command}): ${err.message}. Install Claude Code and sign in, or set NOMAD_MEMORY_CLAUDE_CLI to its path.`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          resolve(parseClaudeCliOutput(stdout));
        } catch (err) {
          const why = stderr.trim() ? ` (exit ${code}: ${stderr.trim().slice(0, 200)})` : ` (exit ${code})`;
          reject(new Error(`${(err as Error).message}${why}`));
        }
      });
      child.stdin.end(userMessage);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
