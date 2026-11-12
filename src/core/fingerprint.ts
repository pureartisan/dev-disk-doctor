import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ScanOptions } from './types.js';
import { version } from './version.js';

/**
 * The options that decide what a scan finds, in one canonical form: defaults are already applied by
 * `buildOptions`, paths are absolute with no trailing slash, and lists are deduplicated and sorted, so two runs
 * that mean the same thing compare equal however they were typed. Timeouts do not change what is found, so they
 * are left out. The tool version is in, so a new release never trusts a scan made by older detector logic.
 */
export function normaliseOptions(opts: ScanOptions): Record<string, unknown> {
  const tidy = (xs: string[]) => [...new Set(xs)].sort();
  return {
    version: version(),
    platform: opts.platform,
    home: path.resolve(opts.home),
    roots: tidy(opts.roots.map((r) => path.resolve(r))),
    minBytes: Math.round(opts.minBytes),
    staleDays: opts.staleDays,
    deep: Boolean(opts.deep),
    only: tidy(opts.only ?? []),
  };
}

/** A short checksum of the normalised options. Saved with a scan to tell whether a later run asks the same question. */
export function fingerprintOptions(opts: ScanOptions): string {
  return createHash('sha256').update(JSON.stringify(normaliseOptions(opts))).digest('hex').slice(0, 16);
}
