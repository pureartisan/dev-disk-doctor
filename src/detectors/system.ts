import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from '../core/exec.js';
import { sizeOf } from '../core/size.js';
import { daysAgo, listDir } from '../core/util.js';
import type { Detector, Finding } from '../core/types.js';
import { manualAction, pathFinding, removeAction } from './helpers.js';

export const system: Detector = {
  id: 'system',
  title: 'Trash, Downloads, logs, backups, snapshots',
  async run(opts) {
    const h = opts.home;
    const findings: Finding[] = [];

    const trash = await pathFinding(
      {
        detector: 'system',
        key: 'trash',
        category: 'system',
        title: 'Trash',
        path: path.join(h, '.Trash'),
        risk: 'review',
        regenerable: false,
        why: 'Deleted files still occupy disk until the Trash is emptied.',
        actions: (id) => [manualAction(id, 'empty', 'Empty the Trash in Finder', 'Finder → Empty Trash', 'review', 'Permanent. Look through it first.')],
      },
      opts,
    );
    if (trash) findings.push(trash);

    const logs = await pathFinding(
      {
        detector: 'system',
        key: 'logs',
        category: 'system',
        title: 'User logs (~/Library/Logs)',
        path: path.join(h, 'Library/Logs'),
        risk: 'review',
        regenerable: true,
        why: 'Application and crash logs. Apps recreate them.',
        // macOS will not let this tool remove the folder (EACCES), so it is only ever shown, never run or selectable.
        actions: (id) => [
          manualAction(id, 'protected', 'Protected by macOS: this tool cannot delete it', 'open ~/Library/Logs', 'review', 'macOS protects this folder. Clear old logs inside it by hand if you want the space.'),
        ],
      },
      opts,
    );
    if (logs) findings.push(logs);

    const backups = await pathFinding(
      {
        detector: 'system',
        key: 'ios-backups',
        category: 'system',
        title: 'iPhone and iPad backups',
        path: path.join(h, 'Library/Application Support/MobileSync/Backup'),
        risk: 'danger',
        regenerable: false,
        why: 'Local device backups made by Finder. They may be the only copy of data from an old device.',
        actions: (id) => [manualAction(id, 'manage', 'Manage backups in Finder', 'Finder → device → Manage Backups…', 'danger', 'Deleting a backup is permanent.')],
      },
      opts,
    );
    if (backups) findings.push(backups);

    // Large files in Downloads.
    const downloads = path.join(h, 'Downloads');
    const bigFloor = Math.max(opts.minBytes, 500 * 1024 * 1024);
    for (const name of await listDir(downloads)) {
      const p = path.join(downloads, name);
      let st;
      try {
        st = await fs.lstat(p);
      } catch {
        continue;
      }
      const bytes = (await sizeOf(p, opts.detectorTimeoutMs)) ?? 0;
      if (bytes < bigFloor) continue;
      const id = `system:download:${name}`;
      findings.push({
        id,
        detector: 'system',
        category: 'system',
        title: `Large download: ${name}`,
        path: p,
        bytes,
        risk: 'review',
        regenerable: false,
        why: `Sits in Downloads, last modified ${daysAgo(st.mtimeMs)} days ago. Installers and disk images are usually safe to delete once installed.`,
        actions: [removeAction(id, p, 'review', bytes, 'This is a personal file, not a cache. Check what it is first.', 'Delete this download')],
      });
    }

    if (opts.platform === 'darwin') {
      const snap = await run('tmutil', ['listlocalsnapshots', '/'], { timeoutMs: 15_000 });
      const count = snap.ok ? snap.stdout.split('\n').filter((l) => l.includes('com.apple.TimeMachine')).length : 0;
      if (count > 0) {
        const id = 'system:tm-snapshots';
        findings.push({
          id,
          detector: 'system',
          category: 'system',
          title: `Time Machine local snapshots (${count})`,
          bytes: 0,
          risk: 'review',
          regenerable: true,
          why: 'macOS keeps local snapshots on this disk and normally frees them when space runs low, but they can inflate "used" space. Their size is not reported by du.',
          actions: [
            manualAction(id, 'thin', 'Thin local snapshots', 'sudo tmutil thinlocalsnapshots / 50000000000 4', 'review', 'Needs sudo. Snapshots are only a local convenience; your real backup is on the backup disk.'),
          ],
        });
      }
    }
    return findings;
  },
};
