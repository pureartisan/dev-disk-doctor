import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

export async function readText(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** A duration as people read it: "0.8s", "42s", "1m 12s". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Parse sizes printed by Docker ("196.2GB", "58.38MB", "0B"). Docker uses decimal units. */
export function parseDockerSize(s: string): number {
  const m = /^\s*(-?[\d.]+)\s*([kKmMgGtT]?)B/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult: Record<string, number> = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  return Math.max(0, Math.round(n * (mult[m[2].toLowerCase()] ?? 1)));
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** True when `child` is `parent` or lives inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function daysAgo(ms: number, now = Date.now()): number {
  // A just-written file can have an mtime slightly ahead of Date.now(); never report negative idle time.
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}
