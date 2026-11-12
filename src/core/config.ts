import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expandHome, isDir } from './util.js';

/**
 * Saved settings live in `~/.dev-disk-doctor/config`, a JSON file:
 * `{ "roots": ["/abs/path", ...], "autoDiscover": true }`.
 * `autoDiscover` records that the user chose "figure it out for me", so the first-run question is not asked again.
 */
export interface Config {
  roots: string[];
  autoDiscover: boolean;
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
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [], autoDiscover: false };
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
  if (!text.trim()) return { roots: [], autoDiscover: false };
  try {
    const parsed = JSON.parse(text) as { roots?: unknown; autoDiscover?: unknown };
    const roots = Array.isArray(parsed.roots) ? parsed.roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [];
    return { roots: roots.map((r) => path.resolve(expandHome(r, home))), autoDiscover: parsed.autoDiscover === true };
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it, then try again.`);
  }
}

async function writeConfig(home: string, config: Config): Promise<void> {
  const file = configPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: Partial<Config> = { roots: config.roots };
  if (config.autoDiscover) body.autoDiscover = true;
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
