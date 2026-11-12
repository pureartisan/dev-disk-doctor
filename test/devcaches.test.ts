import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertSafeToRemove } from '../src/core/fix.js';
import { isInside } from '../src/core/util.js';
import { browsers, models } from '../src/detectors/browsers-models.js';
import { devcaches, knownCaches } from '../src/detectors/devcaches.js';
import { pkgcaches } from '../src/detectors/pkgcaches.js';
import { opts, tmp, write } from './helpers.js';

const HOME = '/Users/example';
const platforms = ['darwin', 'linux'] as const;

describe('built-in cache list', () => {
  for (const platform of platforms) {
    describe(platform, () => {
      const defs = knownCaches(HOME, platform);

      it('has unique keys and no path listed twice', () => {
        const keys = defs.map((d) => d.key);
        assert.equal(new Set(keys).size, keys.length, 'duplicate key');
        const paths = defs.flatMap((d) => d.paths);
        assert.equal(new Set(paths).size, paths.length, 'a path appears in two entries');
      });

      it('only lists paths the delete guard accepts', () => {
        for (const d of defs) {
          assert.ok(d.paths.length > 0, `${d.key} has no paths`);
          for (const p of d.paths) assert.doesNotThrow(() => assertSafeToRemove(p, { home: HOME, roots: [] }), `${d.key}: ${p}`);
        }
      });

      it('never nests one entry inside another, so nothing is counted twice', () => {
        const paths = defs.flatMap((d) => d.paths);
        for (const a of paths) for (const b of paths) if (a !== b) assert.ok(!isInside(a, b), `${a} is inside ${b}`);
      });

      it('keeps data (VM disks) out of the deletable set', () => {
        for (const d of defs) {
          assert.equal(Boolean(d.keep), d.risk === 'danger', `${d.key}: danger and keep must go together`);
          assert.ok(!(d.keep && d.clean), `${d.key}: cannot be both kept and cleaned`);
          assert.ok(d.why.length > 20, `${d.key} needs an explanation`);
        }
      });
    });
  }

  it('covers every ecosystem it claims to', () => {
    const keys = new Set(knownCaches(HOME, 'darwin').map((d) => d.key));
    for (const k of ['corepack', 'deno', 'poetry', 'pre-commit', 'go-modcache', 'nuget', 'composer', 'pub-cache', 'swiftpm', 'android-build-cache', 'whisper', 'llama-cpp', 'triton', 'terraform-plugins', 'helm', 'cursor-cache', 'firefox', 'colima', 'orbstack']) {
      assert.ok(keys.has(k), `missing ${k}`);
    }
  });

  it('does not repeat what the other detectors already report', async () => {
    const home = tmp();
    for (const platform of platforms) for (const d of knownCaches(home, platform)) for (const p of d.paths) write(path.join(p, 'x'));
    for (const platform of platforms) {
      const o = opts(home, { platform, minBytes: 1 });
      const mine = new Set(knownCaches(home, platform).flatMap((d) => d.paths));
      for (const other of [pkgcaches, browsers, models]) {
        for (const f of await other.run(o, () => [])) assert.ok(!mine.has(f.path!), `${other.id} already reports ${f.path}`);
      }
    }
  });
});

describe('devcaches detector', () => {
  it('reports the caches that exist, with a delete action for regenerable ones', async () => {
    const home = tmp();
    write(path.join(home, '.nuget/packages/pkg/lib.dll'));
    write(path.join(home, '.cache/node/corepack/yarn/x'));
    const findings = await devcaches.run(opts(home, { platform: 'linux', minBytes: 1 }), () => []);
    const byId = new Map(findings.map((f) => [f.id, f]));
    assert.deepEqual([...byId.keys()].sort(), ['devcaches:corepack', 'devcaches:nuget']);
    const nuget = byId.get('devcaches:nuget')!;
    assert.equal(nuget.risk, 'safe');
    assert.deepEqual(nuget.actions.map((a) => a.kind.type), ['remove-path']);
  });

  it('uses the tool\'s own cleaner where deleting the folder would fail', async () => {
    const home = tmp();
    write(path.join(home, 'go/pkg/mod/example.com/m@v1/a.go'));
    const [f] = await devcaches.run(opts(home, { platform: 'linux', minBytes: 1 }), () => []);
    assert.equal(f.id, 'devcaches:go-modcache');
    assert.equal(f.actions[0].kind.type, 'exec');
    assert.equal(f.actions[0].display, 'go clean -modcache');
  });

  it('flags a review item and gives it a warning', async () => {
    const home = tmp();
    write(path.join(home, '.pub-cache/hosted/x'));
    const [f] = await devcaches.run(opts(home, { platform: 'linux', minBytes: 1 }), () => []);
    assert.equal(f.risk, 'review');
    assert.match(f.actions[0].warning ?? f.why, /pub global activate/);
  });

  it('reports VM and container data as danger with advice only, never a delete', async () => {
    const home = tmp();
    write(path.join(home, '.colima/default/diffdisk'));
    const [f] = await devcaches.run(opts(home, { platform: 'darwin', minBytes: 1 }), () => []);
    assert.equal(f.id, 'devcaches:colima');
    assert.equal(f.risk, 'danger');
    assert.equal(f.regenerable, false);
    assert.deepEqual(f.actions.map((a) => a.kind.type), ['manual']);
    assert.match(f.actions[0].warning ?? '', /colima delete/);
  });

  it('reports each location that exists, with a stable key per location', async () => {
    const home = tmp();
    mkdirSync(path.join(home, 'Library/Caches/Firefox'), { recursive: true });
    write(path.join(home, 'Library/Caches/Firefox/a'));
    write(path.join(home, '.cache/mozilla/b'));
    const findings = await devcaches.run(opts(home, { platform: 'darwin', minBytes: 1 }), () => []);
    assert.deepEqual(findings.map((f) => f.id).sort(), ['devcaches:firefox', 'devcaches:firefox@1']);
  });

  it('puts macOS editor caches under Application Support and Linux ones under ~/.config', async () => {
    const mac = knownCaches(HOME, 'darwin').find((d) => d.key === 'cursor-cache')!;
    const linux = knownCaches(HOME, 'linux').find((d) => d.key === 'cursor-cache')!;
    assert.deepEqual(mac.paths, [`${HOME}/Library/Application Support/Cursor/Cache`]);
    assert.deepEqual(linux.paths, [`${HOME}/.config/Cursor/Cache`]);
  });
});
