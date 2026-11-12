import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fingerprintOptions } from './fingerprint.js';
import type { ScanOptions, ScanResult } from './types.js';

/** How old a saved scan may be before `fix` stops reusing it and scans again. */
export const FIX_REUSE_MS = 5 * 60_000;

/**
 * The last text scan lives in `~/.dev-disk-doctor/last-scan.json`, so `show` can page through it without scanning
 * again, and `fix` can reuse it while it is recent (see `loadMatchingScan`). Whatever uses it, `fix` re-checks the
 * items it is about to run when the scan is more than a minute old.
 */
export function scanCachePath(home: string): string {
  return path.join(home, '.dev-disk-doctor', 'last-scan.json');
}

export async function saveScan(home: string, result: ScanResult): Promise<void> {
  const file = scanCachePath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write beside it and rename, so a run that is stopped halfway never leaves a half-written cache behind.
  const part = `${file}.${process.pid}.tmp`;
  await fs.writeFile(part, JSON.stringify(result));
  await fs.rename(part, file);
}

/** The saved scan, or undefined when there is none or it is unreadable or from another schema. */
export async function loadScan(home: string): Promise<ScanResult | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(scanCachePath(home), 'utf8')) as Partial<ScanResult>;
    return parsed.schema === 1 && Array.isArray(parsed.findings) && typeof parsed.generatedAt === 'string' ? (parsed as ScanResult) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `result` answers the same question as a run with `opts` would: made with the same normalised options
 * and, when `maxAgeMs` is given, no older than that. A scan from the future (clock change) or from before
 * fingerprints were saved never matches.
 */
export function scanMatches(result: ScanResult, opts: ScanOptions, maxAgeMs = Infinity, now = Date.now()): boolean {
  if (!result.fingerprint || result.fingerprint !== fingerprintOptions(opts)) return false;
  const age = now - Date.parse(result.generatedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

/** The saved scan if it matches `opts` (and is recent enough, when `maxAgeMs` is given), else undefined. */
export async function loadMatchingScan(opts: ScanOptions, maxAgeMs = Infinity, now = Date.now()): Promise<ScanResult | undefined> {
  const saved = await loadScan(opts.home);
  return saved && scanMatches(saved, opts, maxAgeMs, now) ? saved : undefined;
}

/** Forget the saved scan, e.g. once a fix has changed what is on disk. */
export async function clearScan(home: string): Promise<void> {
  await fs.rm(scanCachePath(home), { force: true });
}

export function describeAge(generatedAt: string, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - Date.parse(generatedAt)) / 1000));
  if (secs < 60) return 'moments ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
