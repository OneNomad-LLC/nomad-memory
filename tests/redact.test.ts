/**
 * Secret redaction before storing. The negative cases are real lines from the LongMemEval
 * haystack (code that names passwords and keys without holding one); redacting those would
 * damage memories about code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ENGRAM_LLM_BASE_URL;
delete process.env.PRZM_MEMORY_LLM_BASE_URL;

import { redactSecrets, REDACTED } from '../src/redact.js';
import { Storage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { ingest } from '../src/wal.js';
import { extractFromConversation } from '../src/extractor.js';

describe('redactSecrets', () => {
  const secrets: Array<[string, string]> = [
    ['anthropic key', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['openrouter key', 'export OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789'],
    ['github token', 'token gh' + 'o_LToUyBqL7aKlvuOU0CZKUkqYVVGMxN1KPQPw here'],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['bearer', 'Authorization: Bearer abcDEF123456ghiJKL789mno'],
    ['password assignment', 'password: dckr' + '_pat_QfMnjESK8cyTT6FTQ2tXbEeTubs'],
    ['connection string', 'postgres://admin:s3cretPass99@db.internal:5432/app'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
  ];
  for (const [name, text] of secrets) {
    it(`redacts a ${name}`, () => {
      const r = redactSecrets(text);
      assert.ok(r.redacted > 0, r.text);
      assert.ok(r.text.includes(REDACTED));
    });
  }

  it('keeps the label and drops only the value', () => {
    assert.equal(redactSecrets('postgres://admin:s3cretPass99@db:5432/app').text, `postgres://admin:${REDACTED}@db:5432/app`);
    assert.equal(redactSecrets('api_key="a8f3k2m9q7x1"').text, `api_key="${REDACTED}"`);
  });

  const harmless = [
    'apiKey: string;',
    'accessToken: req.body.accessToken,',
    'password: \'password\',',
    'user="your_username", password="your_password",',
    'api_key: <API_KEY_1>',
    'http://admin:admin@localhost:3000/api/datasources',
    'jdbc:postgresql://host:port/database?user=user&password=password',
    'do api_key=${credentials[$cred].api_key}',
    'The user prefers TypeScript and runs Postgres 16 on a 2024 MacBook.',
    'Deployed build 4f2a9c1 to staging at 14:05.',
  ];
  for (const text of harmless) {
    it(`leaves alone: ${text}`, () => {
      assert.deepEqual(redactSecrets(text), { text, redacted: 0 });
    });
  }
});

describe('write paths', () => {
  it('ingest stores the redacted text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-redact-'));
    try {
      const config = loadConfig({ dataDir: dir, enableChunking: false });
      const storage = new Storage(dir);
      await storage.ensureReady();
      const [chunk] = await ingest(config, storage, [{ content: 'The deploy key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx for prod.' }]);
      assert.equal(chunk.content, `The deploy key is ${REDACTED} for prod.`);
      const stored = await storage.getChunk(chunk.id);
      assert.equal(stored?.content, chunk.content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PRZM_MEMORY_REDACT_SECRETS=0 stores raw text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-redact-'));
    process.env.PRZM_MEMORY_REDACT_SECRETS = '0';
    try {
      const config = loadConfig({ dataDir: dir, enableChunking: false });
      const storage = new Storage(dir);
      await storage.ensureReady();
      const raw = 'The deploy key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx for prod.';
      const [chunk] = await ingest(config, storage, [{ content: raw }]);
      assert.equal(chunk.content, raw);
    } finally {
      delete process.env.PRZM_MEMORY_REDACT_SECRETS;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extraction drops a memory that would have held a secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'przm-redact-'));
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      const chunks = await extractFromConversation(config, storage, [
        { role: 'user', content: 'I always use the key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx for the staging deploys.' },
        { role: 'user', content: 'I always write commit messages in the imperative mood.' },
      ], 'conv-1', { forceExtract: true });
      assert.equal(chunks.length, 1);
      assert.match(chunks[0].content, /imperative mood/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
