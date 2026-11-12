import { cacheProblem, readConfig } from '../core/config.js';
import type { Detector, Finding } from '../core/types.js';
import { pathFinding } from './helpers.js';

/**
 * Caches the user declared with `caches add` (or by editing `~/.dev-disk-doctor/config`). Every entry is
 * checked against the same guard `fix` applies before deleting; an entry that fails it is ignored here and
 * flagged by `dev-disk-doctor caches`.
 *
 * Runs late so it can skip a path an earlier detector already reports.
 */
export const custom: Detector = {
  id: 'custom',
  title: 'Caches you added',
  late: true,
  async run(opts, covered) {
    const { caches } = await readConfig(opts.home);
    const taken = new Set(covered().map((f) => f.path));
    const out: Finding[] = [];
    for (const c of caches) {
      if (cacheProblem(opts.home, c.path) || taken.has(c.path)) continue;
      const shown = c.path.replace(opts.home, '~');
      const f = await pathFinding(
        {
          detector: 'custom',
          key: shown,
          category: 'package-caches',
          title: c.label ? `${c.label} (${shown})` : shown,
          path: c.path,
          risk: c.risk,
          regenerable: c.risk === 'safe',
          why: `A cache you added to ~/.dev-disk-doctor/config, marked ${c.risk === 'safe' ? 'safe to delete' : 'to review first'}. The tool does not know what it holds beyond that.`,
          warning: c.risk === 'review' ? 'You marked this to review: check what is inside before deleting.' : undefined,
        },
        opts,
      );
      if (f) out.push(f);
    }
    return out;
  },
};
