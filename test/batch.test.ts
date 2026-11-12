import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applySafe, safeActions } from '../src/core/fix.js';
import { scan } from '../src/core/scan.js';
import { execFileSync } from 'node:child_process';
import { binName, quoteId, renderFreedSpace, renderScan } from '../src/report/text.js';
import { opts, tmp, write } from './helpers.js';

/** A home with one SAFE item (uv cache) and one REVIEW item (node_modules of a project active today). */
function fixture() {
  const home = tmp();
  write(path.join(home, '.cache/uv/data.bin'));
  write(path.join(home, 'app/package.json'), '{}');
  write(path.join(home, 'app/node_modules/dep/index.js'));
  // Only these detectors: a real docker daemon on the host would otherwise add (and, with confirm, run) its own actions.
  return { home, o: opts(home, { staleDays: 100_000, only: ['pkgcaches', 'projects'] }) };
}

describe('fix safe', () => {
  it('selects only runnable actions on safe findings', async () => {
    const { o } = fixture();
    const res = await scan(o);
    const ids = safeActions(res.findings).map((x) => x.action.id);
    assert.deepEqual(ids, ['pkgcaches:uv#remove']);
    assert.ok(res.findings.some((f) => f.risk === 'review' && f.actions.length), 'fixture has a review item with an action');
  });

  it('dry-runs by default', async () => {
    const { home, o } = fixture();
    const b = await applySafe(o);
    assert.equal(b.dryRun, true);
    assert.equal(b.items.length, 1);
    assert.ok(existsSync(path.join(home, '.cache/uv')));
  });

  it('with confirm cleans safe items and leaves review items alone', async () => {
    const { home, o } = fixture();
    const b = await applySafe(o, true);
    assert.equal(b.ok, true);
    assert.equal(b.dryRun, false);
    assert.ok(!existsSync(path.join(home, '.cache/uv')));
    assert.ok(existsSync(path.join(home, 'app/node_modules')));
  });

  it('reports nothing to do on a clean home', async () => {
    const b = await applySafe(opts(tmp(), { roots: [], only: ['pkgcaches'] }), true);
    assert.deepEqual(b.items, []);
    assert.equal(b.ok, true);
  });
});

describe('scan report', () => {
  it('prints a ready-to-run fix command for every runnable item, safe or review', async () => {
    const { o } = fixture();
    const text = renderScan(await scan(o), { color: false }, { bin: 'dev-disk-doctor' });
    assert.match(text, /run: dev-disk-doctor fix "pkgcaches:uv#remove" --yes/);
    assert.match(text, /run: dev-disk-doctor fix "projects:.*node_modules#remove" --yes/);
    assert.match(text, /dev-disk-doctor fix safe/);
  });

  it('never prints a run line for instructions-only or dangerous items', async () => {
    const home = tmp();
    write(path.join(home, 'Library/Application Support/MobileSync/Backup/abc/file'));
    const text = renderScan(await scan(opts(home, { only: ['system'], roots: [] })), { color: false }, { bin: 'dev-disk-doctor' });
    assert.match(text, /iOS backups|backup/i);
    assert.doesNotMatch(text, /^\s+run:/m);
  });

  it('quotes an id so the shell passes it through unchanged', () => {
    const ids = [
      'pkgcaches:uv#remove',
      'projects:/Users/me/My App/node_modules#remove',
      'projects:/Users/me/$HOME/node_modules#remove',
      'projects:/Users/me/a`b`/node_modules#remove',
      'projects:/Users/me/say "hi"/node_modules#remove',
      "projects:/Users/me/it's/node_modules#remove",
      'projects:/Users/me/wow!/node_modules#remove',
      'projects:/Users/me/back\\slash/node_modules#remove',
    ];
    for (const id of ids) assert.equal(execFileSync('sh', ['-c', `printf %s ${quoteId(id)}`], { encoding: 'utf8' }), id, id);
    assert.equal(quoteId('pkgcaches:uv#remove'), '"pkgcaches:uv#remove"');
  });

  it('suggests npx only when launched through npx', () => {
    assert.equal(binName('/Users/me/.npm/_npx/abc/node_modules/dev-disk-doctor/dist/src/cli.js'), 'npx dev-disk-doctor');
    assert.equal(binName('/usr/local/lib/node_modules/dev-disk-doctor/dist/src/cli.js'), 'dev-disk-doctor');
  });
});

describe('freed space line', () => {
  it('is bold green when space was freed, and plain with colour off or nothing freed', () => {
    const GB = 1024 ** 3;
    assert.equal(renderFreedSpace(2 * GB, { color: true }), '\u001b[1m\u001b[32mFree space changed by 2.00 GB.\u001b[0m\u001b[0m');
    assert.equal(renderFreedSpace(2 * GB, { color: false }), 'Free space changed by 2.00 GB.');
    assert.equal(renderFreedSpace(0, { color: true }), 'Free space changed by 0.00 GB.');
  });
});
