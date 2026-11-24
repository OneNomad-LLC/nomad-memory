/**
 * Read a NOMAD_MEMORY_<suffix> setting. The pre-rename PRZM_MEMORY_<suffix> name is still read as a
 * fallback (deprecated), then any extra legacy names, in order.
 */
export declare function memEnv(suffix: string, legacyNames?: string[], env?: NodeJS.ProcessEnv): string | undefined;
/** `<base>/<nomad name>`, unless only the pre-rename `<base>/<przm name>` exists, so no data is stranded. */
export declare function dirWithLegacyFallback(base: string, ...sub: string[]): string;
export declare const defaultDataDir: () => string;
