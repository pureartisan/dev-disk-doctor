import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertSafeToRemove } from './safety.js';
import { expandHome, isDir, pathExists } from './util.js';

/**
 * Saved settings live in `~/.dev-disk-doctor/config`, a JSON file:
 * `{ "roots": ["/abs/path", ...], "autoDiscover": true, "caches": [{ "path": "~/.cache/foo", "label": "Foo", "risk": "safe" }] }`.
 * `autoDiscover` records that the user chose "figure it out for me", so the first-run question is not asked again.
 * `caches` are folders the user declared as caches the built-in list does not know about.
 */
export interface CustomCache {
  /** Absolute path inside the home folder. */
  path: string;
  label?: string;
  /** `safe` means the owning tool rebuilds it; `review` (the default) means look before deleting. */
  risk: 'safe' | 'review';
}

export interface Config {
  roots: string[];
  autoDiscover: boolean;
  caches: CustomCache[];
}

export function configPath(home: string): string {
  return path.join(home, '.dev-disk-doctor', 'config');
}

export async function readConfig(home: string): Promise<Config> {
  const file = configPath(home);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [], autoDiscover: false, caches: [] };
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
  if (!text.trim()) return { roots: [], autoDiscover: false, caches: [] };
  try {
    const parsed = JSON.parse(text) as { roots?: unknown; autoDiscover?: unknown; caches?: unknown };
    const roots = Array.isArray(parsed.roots) ? parsed.roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [];
    const caches: CustomCache[] = [];
    if (Array.isArray(parsed.caches)) {
      for (const c of parsed.caches as { path?: unknown; label?: unknown; risk?: unknown }[]) {
        if (!c || typeof c.path !== 'string' || !c.path.trim()) continue;
        caches.push({
          path: path.resolve(expandHome(c.path, home)),
          label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : undefined,
          risk: c.risk === 'safe' ? 'safe' : 'review',
        });
      }
    }
    return { roots: roots.map((r) => path.resolve(expandHome(r, home))), autoDiscover: parsed.autoDiscover === true, caches };
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it, then try again.`);
  }
}

async function writeConfig(home: string, config: Config): Promise<void> {
  const file = configPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: Partial<Config> = { roots: config.roots };
  if (config.autoDiscover) body.autoDiscover = true;
  if (config.caches.length) body.caches = config.caches;
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Saved workspace folders, as absolute paths, in the order they were added. Missing folders are kept. */
export async function readSavedRoots(home: string): Promise<string[]> {
  return (await readConfig(home)).roots;
}

/** Resolve a user-supplied folder the way `--root` does (`~` expands, relative paths resolve from the cwd). */
export function resolveRoot(input: string, home: string): string {
  return path.resolve(expandHome(input, home));
}

/** Throws if `input` is not a folder worth searching. Returns its absolute path. */
export async function checkRoot(home: string, input: string): Promise<string> {
  const dir = resolveRoot(input, home);
  if (!(await isDir(dir))) throw new Error(`${dir} is not a folder.`);
  if (dir === path.parse(dir).root) throw new Error('Refusing to use the filesystem root as a workspace folder.');
  if (dir === path.resolve(home)) throw new Error('Refusing to use your whole home folder. Use the folders that hold your code instead.');
  return dir;
}

/** Save a workspace folder so later runs search it without `--root`. Returns the full saved list. */
export async function addSavedRoot(home: string, input: string): Promise<string[]> {
  const dir = await checkRoot(home, input);
  const config = await readConfig(home);
  if (!config.roots.includes(dir)) config.roots.push(dir);
  await writeConfig(home, config);
  return config.roots;
}

/** Forget a saved workspace folder. Works even if the folder no longer exists. Returns the remaining list. */
export async function removeSavedRoot(home: string, input: string): Promise<string[]> {
  const dir = resolveRoot(input, home);
  const config = await readConfig(home);
  if (!config.roots.includes(dir)) throw new Error(`${dir} is not in the saved list.`);
  config.roots = config.roots.filter((r) => r !== dir);
  await writeConfig(home, config);
  return config.roots;
}

/** Remember "figure it out for me", so the first-run question is not asked again. */
export async function saveAutoDiscover(home: string): Promise<void> {
  const config = await readConfig(home);
  config.autoDiscover = true;
  await writeConfig(home, config);
}

/** Forget every saved choice, so the first-run question is asked again. */
export async function resetConfig(home: string): Promise<void> {
  await fs.rm(configPath(home), { force: true });
}

/** Has the user already said where to look, so there is nothing to ask? */
export async function hasRootsChoice(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.DEV_DISK_DOCTOR_ROOTS?.trim()) return true;
  const config = await readConfig(home);
  return config.roots.length > 0 || config.autoDiscover;
}

/** Why a cache path cannot be used, or undefined when it is fine. The same guard `fix` applies before deleting. */
export function cacheProblem(home: string, dir: string): string | undefined {
  try {
    assertSafeToRemove(dir, { home: path.resolve(home), roots: [] });
    return undefined;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).replace(/^Refusing to delete/, 'Refusing to use');
  }
}

/** Caches the user declared, in the order added. Entries that fail the safety guard are kept but flagged. */
export async function listCustomCaches(home: string): Promise<(CustomCache & { problem?: string })[]> {
  const config = await readConfig(home);
  return config.caches.map((c) => ({ ...c, problem: cacheProblem(home, c.path) }));
}

/** Declare a folder as a cache the built-in list does not know about. Replaces an entry for the same path. */
export async function addCustomCache(home: string, input: string, opts: { label?: string; risk?: 'safe' | 'review' } = {}): Promise<CustomCache[]> {
  const dir = resolveRoot(input, home);
  const problem = cacheProblem(home, dir);
  if (problem) throw new Error(`${dir}: ${problem}`);
  if (!(await pathExists(dir))) throw new Error(`${dir} does not exist.`);
  const config = await readConfig(home);
  const entry: CustomCache = { path: dir, label: opts.label?.trim() || undefined, risk: opts.risk ?? 'review' };
  config.caches = [...config.caches.filter((c) => c.path !== dir), entry];
  await writeConfig(home, config);
  return config.caches;
}

/** Forget a declared cache. Works even if the folder no longer exists. */
export async function removeCustomCache(home: string, input: string): Promise<CustomCache[]> {
  const dir = resolveRoot(input, home);
  const config = await readConfig(home);
  if (!config.caches.some((c) => c.path === dir)) throw new Error(`${dir} is not in your cache list.`);
  config.caches = config.caches.filter((c) => c.path !== dir);
  await writeConfig(home, config);
  return config.caches;
}
