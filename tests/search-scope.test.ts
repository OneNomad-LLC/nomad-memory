/**
 * A search filtered by domain, topic or tag must never return a memory outside the filter,
 * whichever stage found it. The graph walk follows links between memories, and links cross
 * domains, so it has to apply the filter too. Runs keyword-only (ENGRAM_SKIP_EMBED=1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';

import { Storage, type StoredChunk } from '../src/storage.js';
import { search } from '../src/search.js';
import { loadConfig } from '../src/config.js';

function chunk(id: string, content: string, extra: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id, tier: 'long-term', content, type: 'fact', cognitiveLayer: 'semantic',
    tags: [], domain: '', topic: '', source: id, importance: 0.5,
    sentiment: 'neutral', createdAt: '2024-03-10T00:00:00.000Z', lastRecalledAt: null,
    recallCount: 0, relatedMemories: [], recallOutcomes: [], ...extra,
  };
}

const link = (targetId: string) => ({ targetId, relationship: 'semantic' as const, weight: 1 });

async function withStore(chunks: StoredChunk[], fn: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'nomad-search-scope-'));
  try {
    const storage = new Storage(dir);
    await storage.ensureReady();
    await storage.saveChunks(chunks);
    await fn(storage);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the store */ }
  }
}

// "alpha" holds the match. It links to a memory in "beta", which links on to another.
const store = [
  chunk('alpha-1', 'The deploy key for the alpha project rotates monthly.', { domain: 'alpha', tags: ['ops'], relatedMemories: [link('beta-1')] }),
  chunk('beta-1', 'Client pricing notes for the beta account.', { domain: 'beta', relatedMemories: [link('beta-2')] }),
  chunk('beta-2', 'Salary bands discussed with the beta team.', { domain: 'beta' }),
];

describe('search filters hold across the graph walk', () => {
  it('a domain filter keeps linked memories from other domains out', async () => {
    await withStore(store, async storage => {
      const results = await search(loadConfig(), storage, 'deploy key rotates', 10, { domain: 'alpha' });
      assert.deepEqual(results.map(r => r.chunk.id), ['alpha-1']);
    });
  });

  it('a tag filter keeps linked memories without the tag out', async () => {
    await withStore(store, async storage => {
      const results = await search(loadConfig(), storage, 'deploy key rotates', 10, { tag: 'ops' });
      assert.deepEqual(results.map(r => r.chunk.id), ['alpha-1']);
    });
  });

  it('with no filter the walk still brings in linked memories', async () => {
    await withStore(store, async storage => {
      const results = await search(loadConfig(), storage, 'deploy key rotates', 10);
      assert.deepEqual(results.map(r => r.chunk.id).sort(), ['alpha-1', 'beta-1', 'beta-2']);
    });
  });
});

describe('the token budget', () => {
  it('skips an item that does not fit and keeps going', async () => {
    const big = `Sprint retro notes. ${'The sprint went long and the notes go on. '.repeat(60)}`;
    await withStore([chunk('big', big), chunk('small', 'Sprint review moved to Monday; sprint demo follows.')], async storage => {
      const results = await search({ ...loadConfig(), maxRecallTokens: 100 }, storage, 'sprint', 10);
      assert.deepEqual(results.map(r => r.chunk.id), ['small']);
    });
  });
});
