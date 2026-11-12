import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScanResult } from './types.js';

/**
 * The last text scan lives in `~/.dev-disk-doctor/last-scan.json`, so `show` can page through it without scanning
 * again. It is only ever displayed: `fix` always re-scans before it runs anything.
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
