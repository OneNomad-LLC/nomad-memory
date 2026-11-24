import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read a NOMAD_MEMORY_<suffix> setting. The pre-rename PRZM_MEMORY_<suffix> name is still read as a
 * fallback (deprecated), then any extra legacy names, in order.
 */
export function memEnv(
  suffix: string,
  legacyNames: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of [`NOMAD_MEMORY_${suffix}`, `PRZM_MEMORY_${suffix}`, ...legacyNames]) {
    if (env[name] !== undefined) return env[name];
  }
  return undefined;
}

/** `<base>/<nomad name>`, unless only the pre-rename `<base>/<przm name>` exists, so no data is stranded. */
export function dirWithLegacyFallback(base: string, ...sub: string[]): string {
  const fresh = join(base, 'nomad-memory', ...sub);
  const old = join(base, 'przm-memory', ...sub);
  return !existsSync(fresh) && existsSync(old) ? old : fresh;
}

export const defaultDataDir = (): string => dirWithLegacyFallback(join(homedir(), '.claude'));
