import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memEnv, dirWithLegacyFallback } from '../src/env.js';

describe('memEnv', () => {
  it('prefers NOMAD_MEMORY_, then NOMAD_MEMORY_, then legacy names', () => {
    assert.equal(memEnv('X', ['OLD_X'], { NOMAD_MEMORY_X: 'a', PRZM_MEMORY_X: 'b', OLD_X: 'c' }), 'a');
    assert.equal(memEnv('X', ['OLD_X'], { PRZM_MEMORY_X: 'b', OLD_X: 'c' }), 'b');
    assert.equal(memEnv('X', ['OLD_X'], { OLD_X: 'c' }), 'c');
    assert.equal(memEnv('X', [], {}), undefined);
  });
});

describe('dirWithLegacyFallback', () => {
  it('uses the nomad dir unless only the przm one exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'nomad-dir-'));
    assert.equal(dirWithLegacyFallback(base), join(base, 'nomad-memory'));
    mkdirSync(join(base, 'przm-memory'));
    assert.equal(dirWithLegacyFallback(base), join(base, 'przm-memory'));
    mkdirSync(join(base, 'nomad-memory'));
    assert.equal(dirWithLegacyFallback(base), join(base, 'nomad-memory'));
  });
});
