import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sizeOf } from '../core/size.js';
import type { Detector, Finding } from '../core/types.js';
import { explainedUnder, manualAction } from './helpers.js';

/** Folders we look inside of, instead of reporting as one opaque lump. */
function expandable(home: string): Set<string> {
  const lib = path.join(home, 'Library');
  const library = ['Containers', 'Application Support', 'Caches', 'Group Containers', 'Android'].map((n) => path.join(lib, n));
  // Where unix tools park caches and data: one lump each would hide which tool is the culprit.
  const dotFolders = ['.cache', '.config', '.local', '.local/share'].map((n) => path.join(home, n));
  return new Set([lib, ...library, ...dotFolders]);
}

async function children(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Sweep for space the specific detectors do not know about. Reports each top-level
 * folder's *uncovered remainder* (its size minus what other findings already explain).
 */
export const biggest: Detector = {
  id: 'biggest',
  title: 'Everything else: unknown space hogs',
  deepOnly: true,
  async run(opts, covered) {
    const expand = expandable(opts.home);
    const queue = await children(opts.home);
    const entries: string[] = [];
    while (queue.length) {
      const p = queue.pop()!;
      if (expand.has(p)) queue.push(...(await children(p)));
      else entries.push(p);
    }

    const known = covered().filter((f) => f.path && f.bytes > 0);
    const findings: Finding[] = [];
    await Promise.all(
      entries.map(async (p) => {
        const total = await sizeOf(p, opts.detectorTimeoutMs * 2);
        if (total === undefined) return;
        const { bytes: explained, count } = explainedUnder(p, known);
        const remainder = total - explained;
        if (remainder < opts.minBytes) return;
        const id = `biggest:${p}`;
        findings.push({
          id,
          detector: 'biggest',
          category: 'unknown',
          title: `${p.replace(opts.home, '~')}${explained > 0 ? ` (excluding ${count} item${count === 1 ? '' : 's'} listed above)` : ''}`,
          path: p,
          bytes: remainder,
          risk: 'review',
          regenerable: false,
          why: 'Not recognised by any specific check. Look inside before deleting; an app\'s own settings, or its in-app "clear cache" option, is usually the safe route.',
          actions: [manualAction(id, 'inspect', 'See what is inside', `du -sh ${JSON.stringify(p)}/* | sort -rh | head -20`, 'safe')],
        });
      }),
    );
    return findings;
  },
};
