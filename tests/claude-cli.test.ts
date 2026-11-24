/**
 * The Claude subscription provider: the locked-down CLI arguments and reading its JSON result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { claudeCliArgs, parseClaudeCliOutput, usesClaudeCli } from '../src/claude-cli.js';

describe('Claude CLI provider', () => {
  it('is chosen only by name', () => {
    delete process.env.NOMAD_MEMORY_LLM_PROVIDER;
    assert.equal(usesClaudeCli(), false);
    for (const name of ['claude-cli', 'claude-subscription', 'Claude']) {
      process.env.NOMAD_MEMORY_LLM_PROVIDER = name;
      assert.equal(usesClaudeCli(), true, name);
    }
    process.env.NOMAD_MEMORY_LLM_PROVIDER = 'openrouter';
    assert.equal(usesClaudeCli(), false);
    delete process.env.NOMAD_MEMORY_LLM_PROVIDER;
  });

  it('runs with no tools, no MCP servers, no hooks and no saved session', () => {
    const args = claudeCliArgs('haiku', '/tmp/s.txt');
    assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'haiku']);
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--system-prompt-file') + 1], '/tmp/s.txt');
    // --bare would refuse subscription sign-in.
    assert.ok(!args.includes('--bare'));
  });

  it('reads the reply, and reports a failure in the CLI’s words', () => {
    assert.equal(parseClaudeCliOutput('{"type":"result","is_error":false,"result":"[]"}\n'), '[]');
    assert.throws(() => parseClaudeCliOutput('{"is_error":true,"result":"Not logged in"}'), /Not logged in/);
    assert.throws(() => parseClaudeCliOutput('oops'), /no JSON result/);
  });
});
