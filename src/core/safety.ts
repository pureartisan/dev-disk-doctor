import path from 'node:path';
import { isInside } from './util.js';
import type { ScanOptions } from './types.js';

const PROTECTED_HOME_CHILDREN = new Set(['Documents', 'Desktop', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', 'Library', 'Downloads']);

/** Defence in depth: detectors only ever produce safe paths, but never trust that blindly. */
export function assertSafeToRemove(target: string, opts: Pick<ScanOptions, 'home' | 'roots'>): void {
  if (!path.isAbsolute(target)) throw new Error('Refusing to delete a relative path.');
  const normalized = path.resolve(target);
  if (normalized !== target.replace(/\/+$/, '') && normalized !== target) throw new Error('Refusing to delete a non-normalised path.');
  if (!isInside(normalized, opts.home) || normalized === opts.home) throw new Error('Refusing to delete anything outside your home folder.');
  const rel = path.relative(opts.home, normalized);
  if (PROTECTED_HOME_CHILDREN.has(rel)) throw new Error(`Refusing to delete ~/${rel} itself.`);
  if (opts.roots.some((r) => path.resolve(r) === normalized)) throw new Error('Refusing to delete a workspace root.');
}
