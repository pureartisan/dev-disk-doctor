import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readSavedRoots } from './config.js';
import { expandHome, isDir } from './util.js';

/** Folder names people commonly keep code in. Always included when present. */
const KNOWN = ['dev', 'code', 'src', 'projects', 'work', 'workspace', 'workspaces', 'Developer', 'repos', 'git', 'Sites'];

/** Top-level folders that are never workspaces: macOS standard folders and cloud-sync mounts (slow, may prompt). */
const NEVER = new Set([
  'Applications', 'Library', 'Documents', 'Desktop', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public',
  'node_modules', 'miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', 'go', 'snap',
]);
const CLOUD = /^(Dropbox|OneDrive|Box|Google Drive|iCloud|Creative Cloud Files|pCloud|MEGA|Sync)/i;

const MARKERS = new Set(['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'Package.swift']);

/** Does this folder hold a git repo or project within a few levels? Bounded so it stays cheap. */
async function looksLikeWorkspace(dir: string): Promise<boolean> {
  let budget = 3000;
  async function walk(d: string, depth: number): Promise<boolean> {
    if (budget-- <= 0) return false;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.some((e) => MARKERS.has(e.name))) return true;
    if (depth >= 3) return false;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (await walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  }
  return walk(dir, 0);
}

/**
 * Where to look for projects and git repos.
 *
 * 1. `DEV_DISK_DOCTOR_ROOTS` (colon-separated) replaces everything below.
 * 2. Folders saved with `dev-disk-doctor roots add` (`~/.dev-disk-doctor/config`) replace everything below.
 * 3. Otherwise: common names (`~/dev`, `~/code`, `~/src`…) plus every other visible folder directly
 *    under your home that contains a git repo or project within three levels. That is how a company
 *    folder such as `~/acme` is found without configuration.
 *
 * `~/Documents`, `~/Desktop` and cloud-sync folders are never searched unless you pass them with `--root`.
 */
export async function defaultRoots(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const fromEnv = env.DEV_DISK_DOCTOR_ROOTS?.split(':').map((s) => s.trim()).filter(Boolean);
  if (fromEnv?.length) {
    const resolved = fromEnv.map((r) => path.resolve(expandHome(r, home)));
    const existing: string[] = [];
    for (const r of resolved) if (await isDir(r)) existing.push(r);
    return existing;
  }

  const saved = await readSavedRoots(home);
  if (saved.length) {
    const existing: string[] = [];
    for (const r of saved) if (await isDir(r)) existing.push(r);
    return existing;
  }

  const roots: string[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir(home);
  } catch {
    return roots;
  }
  const candidates = names.filter((n) => !n.startsWith('.') && !NEVER.has(n) && !CLOUD.test(n));
  const results = await Promise.all(
    candidates.map(async (n) => {
      const p = path.join(home, n);
      if (!(await isDir(p))) return undefined;
      if (KNOWN.includes(n) || (await looksLikeWorkspace(p))) return p;
      return undefined;
    }),
  );
  for (const r of results) if (r) roots.push(r);
  return roots.sort();
}
