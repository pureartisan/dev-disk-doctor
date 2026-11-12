import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { applyAction, assertSafeToRemove } from '../src/core/fix.js';
import { scan } from '../src/core/scan.js';
import { daysAgo, fmtBytes, isInside, parseDockerSize } from '../src/core/util.js';
import { android } from '../src/detectors/android.js';
import { projects } from '../src/detectors/projects.js';
import { opts, tmp, write } from './helpers.js';

describe('util', () => {
  it('parses Docker sizes', () => {
    assert.equal(parseDockerSize('196.2GB'), 196_200_000_000);
    assert.equal(parseDockerSize('58.38MB'), 58_380_000);
    assert.equal(parseDockerSize('0B'), 0);
    assert.equal(parseDockerSize('-2.4GB'), 0);
  });
  it('formats bytes', () => {
    assert.equal(fmtBytes(0), '0 B');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(fmtBytes(5 * 1024 ** 3), '5.0 GB');
  });
  it('isInside is not fooled by prefixes', () => {
    assert.equal(isInside('/a/bc', '/a/b'), false);
    assert.equal(isInside('/a/b/c', '/a/b'), true);
  });
  it('daysAgo counts whole days and is never negative', () => {
    const now = Date.UTC(2026, 0, 10);
    assert.equal(daysAgo(now - 3 * 86_400_000 - 1000, now), 3);
    assert.equal(daysAgo(now, now), 0);
    assert.equal(daysAgo(now + 5, now), 0, 'an mtime slightly in the future is 0 days, not -1');
  });
});

describe('android detector', () => {
  beforeEach(() => {
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    delete process.env.ANDROID_AVD_HOME;
  });

  it('never offers to delete an image an AVD boots from', async () => {
    const home = tmp();
    const img = (rel: string) => path.join(home, 'Library/Android/sdk/system-images', rel, 'system.img');
    write(img('android-36/google_apis_playstore/arm64-v8a'));
    write(img('android-34/android-tv/arm64-v8a'));
    write(path.join(home, '.android/avd/Pixel.avd/config.ini'), 'image.sysdir.1 = system-images/android-36/google_apis_playstore/arm64-v8a/\n');

    const findings = await android.run(opts(home), () => []);
    const used = findings.find((f) => f.id === 'android:image:android-36/google_apis_playstore/arm64-v8a');
    const unused = findings.find((f) => f.id === 'android:image:android-34/android-tv/arm64-v8a');
    assert.equal(used?.risk, 'danger');
    assert.equal(used?.actions.length, 0);
    assert.equal(unused?.risk, 'review');
    assert.equal(unused?.actions[0].kind.type, 'remove-path');
  });
});

describe('projects detector', () => {
  it('finds node_modules and distinguishes stale from active projects', async () => {
    const home = tmp();
    const proj = path.join(home, 'app');
    write(path.join(proj, 'package.json'), '{}');
    write(path.join(proj, 'node_modules/dep/index.js'));
    write(path.join(proj, 'node_modules/dep/node_modules/nested/index.js'));

    const stale = await projects.run(opts(home, { staleDays: 0 }), () => []);
    assert.equal(stale.length, 1, 'nested node_modules is not reported separately');
    assert.equal(stale[0].risk, 'safe');

    const active = await projects.run(opts(home, { staleDays: 100_000 }), () => []);
    assert.equal(active[0].risk, 'review');
  });

  it('only treats target/ as build output next to a Cargo.toml', async () => {
    const home = tmp();
    write(path.join(home, 'notrust/target/file'));
    write(path.join(home, 'rust/Cargo.toml'), '');
    write(path.join(home, 'rust/target/file'));
    const f = await projects.run(opts(home), () => []);
    assert.deepEqual(f.map((x) => path.basename(path.dirname(x.path!))), ['rust']);
  });
});

describe('fix safety', () => {
  const o = { home: '/Users/me', roots: ['/Users/me/dev'] };
  it('refuses paths outside home, home itself, protected folders and workspace roots', () => {
    assert.throws(() => assertSafeToRemove('/etc', o));
    assert.throws(() => assertSafeToRemove('/Users/me', o));
    assert.throws(() => assertSafeToRemove('/Users/me/Documents', o));
    assert.throws(() => assertSafeToRemove('/Users/me/Library', o));
    assert.throws(() => assertSafeToRemove('/Users/me/dev', o));
    assert.throws(() => assertSafeToRemove('relative/path', o));
    assert.doesNotThrow(() => assertSafeToRemove('/Users/me/.cache/uv', o));
  });

  it('dry-runs by default and only deletes with confirm', async () => {
    const home = tmp();
    write(path.join(home, '.cache/uv/data.bin'));
    const o2 = opts(home, { roots: [] });
    const dry = await applyAction(o2, 'pkgcaches:uv#remove');
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.ok(existsSync(path.join(home, '.cache/uv')));

    const real = await applyAction(o2, 'pkgcaches:uv#remove', true);
    assert.equal(real.ok, true);
    assert.equal(real.dryRun, false);
    assert.ok(!existsSync(path.join(home, '.cache/uv')));
  });

  it('refuses danger and manual actions even with confirm', async () => {
    const home = tmp();
    write(path.join(home, 'Library/Application Support/MobileSync/Backup/abc/file'));
    const res = await scan(opts(home, { only: ['system'], roots: [] }));
    const backup = res.findings.find((f) => f.id === 'system:ios-backups');
    assert.equal(backup?.risk, 'danger');
    const out = await applyAction(opts(home, { roots: [] }), 'system:ios-backups#manage', true);
    assert.equal(out.ok, false);
    assert.ok(existsSync(path.join(home, 'Library/Application Support/MobileSync/Backup/abc/file')));
  });

  it('fails safely on an id that no longer exists', async () => {
    const out = await applyAction(opts(tmp(), { roots: [] }), 'pkgcaches:uv#remove', true);
    assert.equal(out.ok, false);
  });
});
