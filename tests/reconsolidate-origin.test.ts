/**
 * Reconsolidation rewrites a recalled memory's text with the LLM. User-asserted memories are
 * canonical (consolidation already refuses to merge or rewrite them), so recall must not
 * rewrite them either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Make the LLM look available but unreachable: if the guard fails, the call is attempted.
process.env.ENGRAM_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.ENGRAM_SKIP_EMBED = '1';

import { reconsolidate } from '../src/extractor.js';
import { loadConfig } from '../src/config.js';
import type { StoredChunk, Storage } from '../src/storage.js';

const chunk = (origin: StoredChunk['origin']): StoredChunk => ({
  id: 'c1',
  tier: 'long-term',
  content: 'Never use em-dashes in writing.',
  type: 'correction',
  cognitiveLayer: 'procedural',
  tags: [],
  domain: '',
  topic: '',
  source: 's',
  importance: 0.9,
  sentiment: 'neutral',
  createdAt: new Date(0).toISOString(),
  lastRecalledAt: null,
  recallCount: 3,
  relatedMemories: [],
  recallOutcomes: [],
  origin,
});

const recent = [
  { role: 'user', content: 'Write the release notes for the new build, keep it short please.' },
  { role: 'assistant', content: 'Here are the release notes, short and without em-dashes.' },
];

test('reconsolidate leaves a user-asserted memory untouched', async () => {
  let writes = 0;
  const storage = { updateChunk: async () => { writes++; } } as unknown as Storage;
  await reconsolidate(loadConfig({ dataDir: '' }), storage, chunk('user'), recent);
  assert.equal(writes, 0);
});

test('reconsolidate still reaches the LLM for a derived memory', async () => {
  const storage = { updateChunk: async () => {} } as unknown as Storage;
  // The endpoint is unreachable, so reaching it shows the guard let a derived chunk through.
  await assert.rejects(reconsolidate(loadConfig({ dataDir: '' }), storage, chunk('derived'), recent));
});
