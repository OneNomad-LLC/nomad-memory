import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bm25Scores, tokenize } from '../src/bm25.js';

const docs = (texts: string[]) => texts.map((text, i) => ({ id: String(i), text }));
const ranked = (scores: Map<string, number>) => [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);

describe('tokenize', () => {
  it('lowercases, splits on punctuation and keeps digits and non-ASCII letters', () => {
    assert.deepEqual(tokenize('Flask 2.3, café-déjà!'), ['flask', '2', '3', 'café', 'déjà']);
  });

  it('sends the forms of a word to one token', () => {
    const same = (...words: string[]) => assert.equal(new Set(words.flatMap(tokenize)).size, 1, words.join(' '));
    same('visit', 'visits', 'visited', 'visiting');
    same('city', 'cities');
    same('stop', 'stopped', 'stopping');
    same('sprint', "sprint's", 'sprints');
  });

  it('leaves tokens with digits alone', () => {
    assert.deepEqual(tokenize('29th v2s 2024'), ['29th', 'v2s', '2024']);
  });
});

describe('bm25Scores', () => {
  it('scores only documents that share a term with the query, best match 1', () => {
    const scores = bm25Scores('budget tracker', docs(['my budget tracker app', 'a recipe for soup', 'budget']));
    assert.deepEqual([...scores.keys()].sort(), ['0', '2']);
    assert.equal(Math.max(...scores.values()), 1);
  });

  it('ranks a rare term above a common one', () => {
    const corpus = docs(['flask app notes', 'flask login', 'flask sqlite', 'flask and matplotlib charts']);
    assert.equal(ranked(bm25Scores('flask matplotlib', corpus))[0], '3');
  });

  it('counts repeats, with diminishing returns', () => {
    // Equal lengths, so only the count differs: one, two and four mentions.
    const s = bm25Scores('sprint', docs([
      'sprint alpha beta gamma delta', 'sprint sprint alpha beta gamma', 'sprint sprint sprint sprint alpha', 'nothing here at all today',
    ]));
    const [one, two, four] = [s.get('0')!, s.get('1')!, s.get('2')!];
    assert.ok(two > one && four > two);
    assert.ok(four - two < two - one, 'the third and fourth mention add less than the second');
  });

  it('discounts a long document against a short one with the same matches', () => {
    const long = `sprint planning ${'and many other unrelated words '.repeat(40)}`;
    const s = bm25Scores('sprint planning', docs(['sprint planning notes', long, 'something else']));
    assert.ok(s.get('0')! > s.get('1')!);
  });

  it('weights a name capitalised in the query above an ordinary word', () => {
    const corpus = docs(['craig likes tea', 'someone likes coffee', 'craig drinks water', 'tea and coffee']);
    const plain = bm25Scores('craig coffee', corpus);
    const named = bm25Scores('Craig coffee', corpus);
    assert.ok(named.get('0')! / named.get('1')! > plain.get('0')! / plain.get('1')!);
  });

  it('matches across word forms', () => {
    const s = bm25Scores('Which museums did I visit?', docs(['I visited two museums in May', 'the weather was fine']));
    assert.deepEqual([...s.keys()], ['0']);
  });

  it('returns nothing for a query of stop words or an empty corpus', () => {
    assert.equal(bm25Scores('what is the', docs(['what is the plan'])).size, 0);
    assert.equal(bm25Scores('budget', []).size, 0);
  });
});
