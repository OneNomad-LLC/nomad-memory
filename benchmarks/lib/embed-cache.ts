/**
 * Opt-in on-disk embedding cache for benchmark experiments: BENCH_EMBED_CACHE=<dir>.
 *
 * Embedding the corpus is most of a run's wall time, and the corpus doesn't change between
 * two runs that compare search code. With the cache on, write latency is not measured (a hit
 * costs nothing), so published runs leave it off.
 *
 * Each process reads every cache file for the model and appends to a file of its own, so runs
 * can share a cache directory at the same time.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embed, getEmbeddingModelName } from '../../src/llm.js';
import type { SmartMemoryConfig } from '../../src/types.js';

const KEY_BYTES = 20;
const FLUSH_EVERY = 256;

export const embedCacheDir = (): string | undefined => process.env.BENCH_EMBED_CACHE || undefined;

let cache: Map<string, Float32Array> | null = null;
let pending: Buffer[] = [];
let outPath = '';

const slug = (): string => getEmbeddingModelName().replace(/[^a-zA-Z0-9]+/g, '_');

function load(dir: string): Map<string, Float32Array> {
  mkdirSync(dir, { recursive: true });
  const map = new Map<string, Float32Array>();
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(.+)\.d(\d+)\.[^.]+\.bin$/);
    if (!m || m[1] !== slug()) continue;
    const dim = Number(m[2]);
    const rec = KEY_BYTES + dim * 4;
    const buf = readFileSync(join(dir, name));
    // A run killed mid-append can leave a partial record at the end; whole records only.
    for (let off = 0; off + rec <= buf.length; off += rec) {
      const vec = new Float32Array(dim);
      for (let i = 0; i < dim; i++) vec[i] = buf.readFloatLE(off + KEY_BYTES + i * 4);
      map.set(buf.toString('hex', off, off + KEY_BYTES), vec);
    }
  }
  return map;
}

function flush(): void {
  if (pending.length === 0) return;
  appendFileSync(outPath, Buffer.concat(pending));
  pending = [];
}

/** `embed()`, answered from the cache when BENCH_EMBED_CACHE is set. */
export async function cachedEmbed(config: SmartMemoryConfig, text: string, prefix?: string): Promise<number[]> {
  const dir = embedCacheDir();
  if (!dir) return embed(config, text, prefix);
  if (!cache) {
    cache = load(dir);
    process.on('exit', flush);
  }
  const key = createHash('sha1').update(`${config.enableContextualPrefix ? prefix ?? '' : ''}\0${text}`).digest();
  const hex = key.toString('hex');
  const hit = cache.get(hex);
  if (hit) return Array.from(hit);
  const vec = await embed(config, text, prefix);
  if (vec.length === 0) return vec;
  const f32 = Float32Array.from(vec);
  cache.set(hex, f32);
  if (!outPath) outPath = join(dir, `${slug()}.d${vec.length}.${process.pid}-${Date.now()}.bin`);
  pending.push(key, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  if (pending.length >= FLUSH_EVERY * 2) flush();
  return vec;
}
