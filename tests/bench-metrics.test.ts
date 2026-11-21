/**
 * The benchmark scoring helpers: recall_any / recall_all / NDCG / answer containment, the
 * streaming JSON splitter the 2.7 GB LongMemEval M file needs, and how a LongMemEval entry
 * becomes a corpus at session and turn level.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_SKIP_EMBED = '1';

import { recallAny, recallAll, ndcg, answerHit } from '../benchmarks/lib/retrieval.js';
import { streamJsonArray, lmeCorpus, type LmeEntry } from '../benchmarks/lib/datasets.js';

describe('retrieval metrics', () => {
  const retrieved = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('recall_any needs one hit, recall_all needs every one', () => {
    assert.equal(recallAny(retrieved, ['e', 'z'], 5), 1);
    assert.equal(recallAll(retrieved, ['e', 'z'], 5), 0);
    assert.equal(recallAll(retrieved, ['a', 'e'], 5), 1);
    assert.equal(recallAll(retrieved, ['a', 'f'], 5), 0);
    assert.equal(recallAll(retrieved, [], 5), 0);
  });

  it('NDCG is 1 for a perfect ranking and falls with rank', () => {
    assert.equal(ndcg(retrieved, ['a', 'b'], 10), 1);
    const low = ndcg(retrieved, ['f'], 10);
    assert.ok(low > 0 && low < 1);
    assert.equal(ndcg(retrieved, ['z'], 10), 0);
  });

  it('answer containment is case- and space-insensitive', () => {
    assert.equal(answerHit(['He was born in  New York.'], ['new york'], 5), 1);
    assert.equal(answerHit(['He was born in Boston.'], ['New York'], 5), 0);
  });
});

describe('streamJsonArray', () => {
  it('yields each entry across read boundaries, braces and escapes inside strings included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-stream-'));
    try {
      const entries = [{ a: 'x { y } [z]', b: [1, { c: 'q"uote\\' }] }, { a: '', b: [] }, { a: 'ünï', b: [[2]] }, { a: `${'é'.repeat(3_000_000)}{"[`, b: [] }, { a: 'after the 4 MB read boundary', b: [3] }];
      const path = join(dir, 'a.json');
      writeFileSync(path, JSON.stringify(entries, null, 2));
      const out: unknown[] = [];
      for await (const e of streamJsonArray(path)) out.push(e);
      assert.deepEqual(out, entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lmeCorpus', () => {
  const entry: LmeEntry = {
    question_id: 'q1', question_type: 'single-session-user', question: 'Where do I live?', answer: 'Lisbon',
    question_date: '2023/05/30', haystack_session_ids: ['s1', 's2'], haystack_dates: ['2023/05/01', '2023/05/02'],
    haystack_sessions: [
      [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
      [{ role: 'user', content: 'I live in Lisbon.', has_answer: true }, { role: 'assistant', content: 'Nice.' }],
    ],
    answer_session_ids: ['s2'],
  };

  it('session level: one item per session, evidence from answer_session_ids', () => {
    const c = lmeCorpus(entry, 'session')!;
    assert.deepEqual(c.items.map(i => i.source), ['s1', 's2']);
    assert.deepEqual(c.query.relevant, ['s2']);
  });

  it('turn level: one item per turn, evidence from has_answer', () => {
    const c = lmeCorpus(entry, 'turn')!;
    assert.equal(c.items.length, 4);
    assert.deepEqual(c.query.relevant, ['s2#0']);
  });

  it('turn level with no has_answer turn has nothing to score', () => {
    const none = { ...entry, haystack_sessions: entry.haystack_sessions.map(s => s.map(m => ({ role: m.role, content: m.content }))) };
    assert.equal(lmeCorpus(none, 'turn'), null);
  });
});
