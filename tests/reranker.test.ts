/**
 * The cross-encoder must tell a relevant document from an irrelevant one. It once scored every
 * document 1.0 (a softmax over the model's single logit), which made reranking a no-op.
 *
 * Skipped when ENGRAM_SKIP_EMBED=1: the model downloads once on first run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rerank } from '../src/reranker.js';

describe('rerank', { skip: process.env.ENGRAM_SKIP_EMBED === '1' }, () => {
  it('puts the document that answers the query first, with distinct scores', async () => {
    const docs = [
      'Flask is a lightweight web framework for Python.',
      'The first sprint ends on March 29 and covers registration and login.',
      'Always format code snippets with syntax highlighting.',
    ];
    const ranked = await rerank('When does my first sprint end?', docs, 3);
    assert.equal(ranked.length, 3);
    assert.equal(ranked[0].index, 1);
    assert.ok(ranked[0].score > ranked[1].score + 1, 'the answer stands clear of the rest');
  });

  it('scores more documents than one batch holds and keeps their indices', async () => {
    const docs = Array.from({ length: 20 }, (_, i) => (i === 17 ? 'The cat is named Biscuit.' : `Unrelated note number ${i} about weather.`));
    const ranked = await rerank('What is the name of the cat?', docs, 20);
    assert.equal(ranked.length, 20);
    assert.equal(ranked[0].index, 17);
  });
});
