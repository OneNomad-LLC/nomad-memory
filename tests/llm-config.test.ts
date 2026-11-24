/**
 * Provider-agnostic LLM settings and the embedding model's cache directory.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isLlmAvailable, getLlmModelName, resolveModelCacheDir } from '../src/llm.js';

const LLM_VARS = [
  'NOMAD_MEMORY_LLM_BASE_URL', 'ENGRAM_LLM_BASE_URL',
  'NOMAD_MEMORY_LLM_API_KEY', 'OPENROUTER_API_KEY',
  'NOMAD_MEMORY_LLM_MODEL', 'ENGRAM_MODEL', 'SMART_MEMORY_MODEL',
];

describe('LLM settings', () => {
  beforeEach(() => { for (const v of LLM_VARS) delete process.env[v]; });

  it('nothing set: no LLM', () => {
    assert.equal(isLlmAvailable(), false);
  });

  it('a key alone uses OpenRouter, under either name', () => {
    process.env.NOMAD_MEMORY_LLM_API_KEY = 'k';
    assert.equal(isLlmAvailable(), true);
    delete process.env.NOMAD_MEMORY_LLM_API_KEY;
    process.env.OPENROUTER_API_KEY = 'k';
    assert.equal(isLlmAvailable(), true);
  });

  it('a custom base URL needs no key, under either name', () => {
    process.env.NOMAD_MEMORY_LLM_BASE_URL = 'http://localhost:11434/v1';
    assert.equal(isLlmAvailable(), true);
    delete process.env.NOMAD_MEMORY_LLM_BASE_URL;
    process.env.ENGRAM_LLM_BASE_URL = 'http://localhost:11434/v1';
    assert.equal(isLlmAvailable(), true);
  });

  it('OpenRouter named explicitly still needs a key', () => {
    process.env.NOMAD_MEMORY_LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    assert.equal(isLlmAvailable(), false);
  });

  it('model: new name, then legacy, then the default', () => {
    assert.equal(getLlmModelName(), 'anthropic/claude-haiku-4.5');
    process.env.ENGRAM_MODEL = 'legacy/model';
    assert.equal(getLlmModelName(), 'legacy/model');
    process.env.NOMAD_MEMORY_LLM_MODEL = 'new/model';
    assert.equal(getLlmModelName(), 'new/model');
  });
});

describe('resolveModelCacheDir', () => {
  it('NOMAD_MEMORY_MODEL_DIR wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-models-'));
    process.env.NOMAD_MEMORY_MODEL_DIR = join(dir, 'override');
    try {
      assert.equal(resolveModelCacheDir(join(dir, 'default')), join(dir, 'override'));
    } finally {
      delete process.env.NOMAD_MEMORY_MODEL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a writable library default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-models-'));
    try {
      assert.equal(resolveModelCacheDir(join(dir, 'default')), join(dir, 'default'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back under the home directory when the default is not writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-models-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try {
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, '');
      assert.equal(resolveModelCacheDir(join(blocker, 'cache')), join(dir, '.cache', 'nomad-memory', 'models'));
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
      if (saved.HOME === undefined) delete process.env.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
