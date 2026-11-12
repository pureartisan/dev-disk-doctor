import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addCustomCache } from '../src/core/config.js';
import { applyAction } from '../src/core/fix.js';
import { scan } from '../src/core/scan.js';
import { biggest } from '../src/detectors/biggest.js';
import { discovery } from '../src/detectors/discovery.js';
import { opts, tmp, write } from './helpers.js';

describe('cache discovery', () => {
  it('reports unrecognised folders in the usual cache locations and nothing else', async () => {
    const home = tmp();
    write(path.join(home, '.cache/mystery-tool/data.bin'));
    write(path.join(home, '.local/share/some-app/db'));
    write(path.join(home, 'Library/Caches/Some App/blob'));
    write(path.join(home, 'Library/Caches/com.apple.Safari/blob'));
    write(path.join(home, 'elsewhere/not-a-cache/blob'));

    const findings = await discovery.run(opts(home, { platform: 'darwin', minBytes: 1 }), () => []);
    assert.deepEqual(
      findings.map((f) => f.id).sort(),
      ['discovery:~/.cache/mystery-tool', 'discovery:~/.local/share/some-app', 'discovery:~/Library/Caches/Some App'],
    );
  });

  it('looks inside ~/Library/Caches only on macOS', async () => {
    const home = tmp();
    write(path.join(home, 'Library/Caches/Some App/blob'));
    assert.deepEqual(await discovery.run(opts(home, { platform: 'linux', minBytes: 1 }), () => []), []);
  });

  it('only suggests looking inside: no action can delete', async () => {
    const home = tmp();
    write(path.join(home, '.cache/mystery-tool/data.bin'));
    const o = opts(home, { platform: 'linux', minBytes: 1, only: ['discovery'] });
    const [f] = (await scan(o)).findings;
    assert.equal(f.risk, 'review');
    assert.equal(f.regenerable, false);
    assert.deepEqual(f.actions.map((a) => a.kind.type), ['manual']);

    const res = await applyAction(o, f.actions[0].id, true);
    assert.equal(res.ok, false);
    assert.match(res.message, /instructions only/);
  });

  it('skips folders another detector already explains, and subtracts them from a folder that holds one', async () => {
    const home = tmp();
    write(path.join(home, '.cache/uv/data.bin')); // pkgcaches reports ~/.cache/uv
    write(path.join(home, '.cache/mystery-tool/data.bin'));
    const res = await scan(opts(home, { platform: 'linux', minBytes: 1, only: ['pkgcaches', 'discovery'] }));
    const ids = res.findings.map((f) => f.id).sort();
    assert.deepEqual(ids, ['discovery:~/.cache/mystery-tool', 'pkgcaches:uv']);
  });

  it('does not list a cache the user added by hand', async () => {
    const home = tmp();
    write(path.join(home, '.cache/mine/data.bin'));
    write(path.join(home, '.cache/mystery-tool/data.bin'));
    await addCustomCache(home, '~/.cache/mine', { risk: 'safe' });
    const res = await scan(opts(home, { platform: 'linux', minBytes: 1, only: ['custom', 'discovery'] }));
    assert.deepEqual(res.findings.map((f) => f.id).sort(), ['custom:~/.cache/mine', 'discovery:~/.cache/mystery-tool']);
  });

  it('runs in the default scan, without --deep', async () => {
    const home = tmp();
    write(path.join(home, '.cache/mystery-tool/data.bin'));
    const res = await scan(opts(home, { platform: 'linux', minBytes: 1, only: ['discovery'], deep: false }));
    assert.equal(res.findings.length, 1);
    assert.equal(res.skipped.length, 0);
  });
});

describe('deep sweep', () => {
  it('names the tool inside ~/.cache, ~/.config and ~/.local/share instead of one lump each', async () => {
    const home = tmp();
    write(path.join(home, '.cache/tool-a/x'));
    write(path.join(home, '.config/tool-b/x'));
    write(path.join(home, '.local/share/tool-c/x'));
    write(path.join(home, '.local/bin/tool-d'));
    const found = (await biggest.run(opts(home, { platform: 'linux', minBytes: 1 }), () => [])).map((f) => f.path!.replace(home, '~')).sort();
    assert.deepEqual(found, ['~/.cache/tool-a', '~/.config/tool-b', '~/.local/bin', '~/.local/share/tool-c']);
  });
});
