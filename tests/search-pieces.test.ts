/**
 * A long memory is stored as a parent container plus child pieces. Search returns the best
 * piece of each memory once, and never the container. Runs keyword-only (ENGRAM_SKIP_EMBED=1),
 * so no model download.
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

async function withStore(chunks: StoredChunk[], fn: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'nomad-search-pieces-'));
  try {
    const storage = new Storage(dir);
    await storage.ensureReady();
    await storage.saveChunks(chunks);
    await fn(storage);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the store */ }
  }
}

const pieces = [
  'The budget tracker uses Flask and SQLite for storage.',
  'The budget tracker sprint ends on March 29.',
  'The budget tracker has charts for monthly spending.',
];
const split = [
  chunk('parent', pieces.join('\n\n'), { consolidationLevel: -1 }),
  ...pieces.map((text, i) => chunk(`piece-${i}`, text, { parentChunkId: 'parent', source: 'parent' })),
];

describe('search over split memories', () => {
  it('returns one piece per memory, the best-matching one', async () => {
    await withStore([...split, chunk('other', 'A note about the budget for the office party.')], async storage => {
      const results = await search(loadConfig(), storage, 'When does the budget tracker sprint end?', 10);
      const ids = results.map(r => r.chunk.id);
      assert.deepEqual(ids.filter(id => id.startsWith('piece-')), ['piece-1']);
      assert.ok(ids.includes('other'), 'the other memory is not crowded out');
    });
  });

  it('never returns a parent container, even from the time window', async () => {
    await withStore(split, async storage => {
      // "March 2024" opens a time window that takes in every chunk created that month.
      const results = await search(loadConfig(), storage, 'What happened in March 2024?', 10);
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.chunk.consolidationLevel !== -1));
      assert.equal(results.filter(r => r.chunk.parentChunkId === 'parent').length, 1);
    });
  });

  it('ranks by BM25: the memory that says it most, for its length, comes first', async () => {
    await withStore([
      chunk('long', `We talked about the sprint once. ${'Then a lot of unrelated planning detail followed. '.repeat(20)}`),
      chunk('short', 'Sprint review: the sprint goal was met and the next sprint starts Monday.'),
    ], async storage => {
      const results = await search(loadConfig(), storage, 'sprint', 10);
      assert.equal(results[0].chunk.id, 'short');
    });
  });
});
