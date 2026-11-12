import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sizeOf } from '../core/size.js';
import type { Detector, Finding } from '../core/types.js';
import { explainedUnder, manualAction } from './helpers.js';

interface Location {
  dir: string;
  /** Why a folder here may or may not be safe to remove. */
  advice: string;
}

async function children(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Caches the specific detectors do not know about. Tools keep caches in a few conventional places, so
 * look at each folder directly inside them and report the ones that are big and not explained by an
 * earlier finding. Nothing here is offered for deletion: the tool cannot vouch for what it does not
 * recognise, so the only action is "look inside".
 */
export const discovery: Detector = {
  id: 'discovery',
  title: 'Unrecognised folders in the usual cache locations',
  late: true,
  async run(opts, covered) {
    const h = opts.home;
    const locations: Location[] = [
      { dir: path.join(h, '.cache'), advice: 'Caches under ~/.cache are normally rebuilt by the tool that made them, but check which tool before deleting.' },
      { dir: path.join(h, '.local/share'), advice: 'This is usually data, not a cache: models, databases, installed tools. Look inside before deleting.' },
    ];
    if (opts.platform === 'darwin') {
      locations.push({ dir: path.join(h, 'Library/Caches'), advice: 'Caches under ~/Library/Caches are normally rebuilt by the app, but quit it first and check what it is.' });
    }

    const known = covered();
    const findings: Finding[] = [];
    for (const loc of locations) {
      const entries = (await children(loc.dir)).filter((p) => !path.basename(p).startsWith('com.apple.'));
      const found = await Promise.all(
        entries.map(async (p): Promise<Finding | undefined> => {
          const total = await sizeOf(p, opts.detectorTimeoutMs);
          if (total === undefined) return undefined;
          const { bytes: explained, count } = explainedUnder(p, known);
          const remainder = total - explained;
          if (remainder < opts.minBytes) return undefined;
          const id = `discovery:${p.replace(h, '~')}`;
          const shown = p.replace(h, '~');
          return {
            id,
            detector: 'discovery',
            category: 'unknown',
            title: `${shown}${explained > 0 ? ` (excluding ${count} item${count === 1 ? '' : 's'} listed above)` : ''}`,
            path: p,
            bytes: remainder,
            risk: 'review',
            regenerable: false,
            why: `Not recognised by any specific check. Found in ${loc.dir.replace(h, '~')}. ${loc.advice}`,
            actions: [manualAction(id, 'inspect', 'See what is inside', `du -sh ${JSON.stringify(p)}/* | sort -rh | head -20`, 'safe')],
          };
        }),
      );
      findings.push(...found.filter((f): f is Finding => f !== undefined));
    }
    return findings;
  },
};
