/**
 * Maintenance embeds chunks that were stored without a vector (the model failed to load at
 * ingest), skips parents, never touches an existing vector, and finishes in one pass.
 * Loads the real embedding model, like alien-query-floor.test.ts.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
delete process.env.ENGRAM_SKIP_EMBED;

import { Storage, type StoredChunk } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { embedMissing } from '../src/reembed.js';

function chunk(id: string, over: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id, tier: 'short-term', content: `The user keeps notes about ${id}.`, type: 'fact',
    cognitiveLayer: 'semantic', tags: [], domain: '', topic: '',
    source: 'embed-missing-test', importance: 0.5, sentiment: 'neutral',
    createdAt: new Date().toISOString(), lastRecalledAt: null, recallCount: 0,
    relatedMemories: [], recallOutcomes: [], consolidationLevel: 0, origin: 'derived', ...over,
  };
}

it('embeds chunks missing a vector and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nomad-embed-missing-'));
  try {
    const storage = new Storage(dir);
    await storage.ensureReady();
    const kept = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    await storage.saveChunks([
      chunk('gardening'),
      chunk('cycling', { embedding: kept }),
      chunk('parent', { consolidationLevel: -1 }),
    ]);

    const config = loadConfig({ dataDir: dir });
    assert.equal(await embedMissing(config, storage), 1);

    const fixed = await storage.getChunk('gardening');
    assert.equal(fixed?.embedding?.length, 384);
    assert.deepEqual((await storage.getChunk('cycling'))?.embedding, kept);
    assert.equal((await storage.getChunk('parent'))?.embedding, undefined);

    assert.equal(await embedMissing(config, storage), 0, 'a second pass finds nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
