/**
 * One maintenance run at a time: callers in one process share the run in flight, a live lock
 * from another process refuses, a lock left by a dead process is taken over, and the
 * scheduler's entry point does nothing when the last run is fresh.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';
process.env.PRZM_MEMORY_BRIDGE_PATH = join(tmpdir(), `przm-lock-bridge-${process.pid}.json`);
delete process.env.OPENROUTER_API_KEY;
delete process.env.ENGRAM_LLM_BASE_URL;
delete process.env.PRZM_MEMORY_LLM_BASE_URL;

import { Storage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import {
  runMaintenance,
  runMaintenanceIfOverdue,
  MaintenanceBusyError,
  readMaintenanceState,
} from '../src/maintenance.js';

async function store() {
  const dir = mkdtempSync(join(tmpdir(), 'przm-lock-'));
  const storage = new Storage(dir);
  await storage.ensureReady();
  return { dir, storage, config: loadConfig({ dataDir: dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('maintenance lock', () => {
  it('concurrent calls in one process share one run', async () => {
    const { storage, config, dir, cleanup } = await store();
    try {
      const [a, b] = await Promise.all([runMaintenance(config, storage), runMaintenance(config, storage)]);
      assert.equal(a, b);
      assert.equal(existsSync(join(dir, 'maintenance.lock')), false);
    } finally {
      cleanup();
    }
  });

  it('refuses while a live process holds the lock', async () => {
    const { storage, config, dir, cleanup } = await store();
    try {
      // The test runner that spawned this file is alive for the duration.
      writeFileSync(join(dir, 'maintenance.lock'), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
      await assert.rejects(runMaintenance(config, storage), MaintenanceBusyError);
      assert.equal(readMaintenanceState(dir).lastRunAt, null);
      assert.equal(existsSync(join(dir, 'maintenance.lock')), true, 'someone else\'s lock is left alone');
    } finally {
      cleanup();
    }
  });

  it('takes over a lock whose process is gone', async () => {
    const { storage, config, dir, cleanup } = await store();
    try {
      writeFileSync(join(dir, 'maintenance.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
      await runMaintenance(config, storage);
      assert.notEqual(readMaintenanceState(dir).lastRunAt, null);
      assert.equal(existsSync(join(dir, 'maintenance.lock')), false);
    } finally {
      cleanup();
    }
  });

  it('takes over a lock older than an hour', async () => {
    const { storage, config, dir, cleanup } = await store();
    try {
      writeFileSync(join(dir, 'maintenance.lock'), JSON.stringify({ pid: process.ppid, at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
      await runMaintenance(config, storage);
      assert.notEqual(readMaintenanceState(dir).lastRunAt, null);
    } finally {
      cleanup();
    }
  });

  it('the scheduler entry point skips a fresh store', async () => {
    const { storage, config, cleanup } = await store();
    try {
      assert.notEqual(await runMaintenanceIfOverdue(config, storage), null, 'never run: overdue');
      assert.equal(await runMaintenanceIfOverdue(config, storage), null, 'just ran: not overdue');
    } finally {
      cleanup();
    }
  });
});
