import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expandHome, isDir } from './util.js';

/** Saved settings live in `~/.dev-disk-doctor/config`, a JSON file: `{ "roots": ["/abs/path", ...] }`. */
export function configPath(home: string): string {
  return path.join(home, '.dev-disk-doctor', 'config');
}

async function readConfig(home: string): Promise<{ roots: string[] }> {
  const file = configPath(home);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [] };
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
  if (!text.trim()) return { roots: [] };
  try {
    const parsed = JSON.parse(text) as { roots?: unknown };
    const roots = Array.isArray(parsed.roots) ? parsed.roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [];
    return { roots };
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it, then try again.`);
  }
}

async function writeConfig(home: string, roots: string[]): Promise<void> {
  const file = configPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ roots }, null, 2)}\n`);
}

/** Saved workspace folders, as absolute paths, in the order they were added. Missing folders are kept. */
export async function readSavedRoots(home: string): Promise<string[]> {
  return (await readConfig(home)).roots.map((r) => path.resolve(expandHome(r, home)));
}

/** Resolve a user-supplied folder the way `--root` does (`~` expands, relative paths resolve from the cwd). */
function resolveRoot(input: string, home: string): string {
  return path.resolve(expandHome(input, home));
}

/** Save a workspace folder so later runs search it without `--root`. Returns the full saved list. */
export async function addSavedRoot(home: string, input: string): Promise<string[]> {
  const dir = resolveRoot(input, home);
  if (!(await isDir(dir))) throw new Error(`${dir} is not a folder.`);
  if (dir === path.parse(dir).root) throw new Error('Refusing to save the filesystem root as a workspace folder.');
  if (dir === path.resolve(home)) throw new Error('Refusing to save your whole home folder. Save the folders that hold your code instead.');
  const roots = await readSavedRoots(home);
  if (!roots.includes(dir)) roots.push(dir);
  await writeConfig(home, roots);
  return roots;
}

/** Forget a saved workspace folder. Works even if the folder no longer exists. Returns the remaining list. */
export async function removeSavedRoot(home: string, input: string): Promise<string[]> {
  const dir = resolveRoot(input, home);
  const roots = await readSavedRoots(home);
  if (!roots.includes(dir)) throw new Error(`${dir} is not in the saved list.`);
  const rest = roots.filter((r) => r !== dir);
  await writeConfig(home, rest);
  return rest;
}
