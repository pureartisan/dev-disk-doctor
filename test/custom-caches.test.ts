import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addCustomCache, configPath, listCustomCaches, readConfig, removeCustomCache } from '../src/core/config.js';
import { applyAction, applySafe } from '../src/core/fix.js';
import { scan } from '../src/core/scan.js';
import { custom } from '../src/detectors/custom.js';
import { opts, tmp, write } from './helpers.js';

describe('caches you add', () => {
  it('saves, lists and removes a cache', async () => {
    const home = tmp();
    write(path.join(home, '.cache/my-tool/blob'));
    await addCustomCache(home, '~/.cache/my-tool', { label: 'My tool', risk: 'safe' });
    assert.deepEqual(await listCustomCaches(home), [{ path: path.join(home, '.cache/my-tool'), label: 'My tool', risk: 'safe', problem: undefined }]);
    assert.deepEqual((await readConfig(home)).caches.map((c) => c.path), [path.join(home, '.cache/my-tool')]);

    await removeCustomCache(home, '~/.cache/my-tool');
    assert.deepEqual(await listCustomCaches(home), []);
    await assert.rejects(removeCustomCache(home, '~/.cache/my-tool'), /not in your cache list/);
  });

  it('defaults to review, and adding the same path again replaces the entry', async () => {
    const home = tmp();
    write(path.join(home, '.cache/my-tool/blob'));
    await addCustomCache(home, '~/.cache/my-tool');
    assert.equal((await listCustomCaches(home))[0].risk, 'review');
    await addCustomCache(home, '~/.cache/my-tool', { risk: 'safe', label: 'Mine' });
    const list = await listCustomCaches(home);
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].risk, list[0].label], ['safe', 'Mine']);
  });

  it('refuses paths the delete guard would refuse, and ones that do not exist', async () => {
    const home = tmp();
    mkdirSync(path.join(home, 'Library'), { recursive: true });
    mkdirSync(path.join(home, 'Documents'), { recursive: true });
    await assert.rejects(addCustomCache(home, '/etc'), /outside your home folder/);
    await assert.rejects(addCustomCache(home, home), /outside your home folder/);
    await assert.rejects(addCustomCache(home, '~/Library'), /Refusing to use ~\/Library/);
    await assert.rejects(addCustomCache(home, '~/Documents'), /Refusing to use ~\/Documents/);
    await assert.rejects(addCustomCache(home, '~/nope'), /does not exist/);
    assert.deepEqual((await readConfig(home)).caches, []);
  });

  it('keeps the other settings when caches change', async () => {
    const home = tmp();
    write(path.join(home, 'code/.keep'));
    write(path.join(home, '.cache/my-tool/blob'));
    write(configPath(home), JSON.stringify({ roots: [path.join(home, 'code')], autoDiscover: true }));
    await addCustomCache(home, '~/.cache/my-tool');
    const c = await readConfig(home);
    assert.deepEqual([c.roots, c.autoDiscover, c.caches.length], [[path.join(home, 'code')], true, 1]);
  });

  it('flags a hand-edited entry that is not allowed, and the scan ignores it', async () => {
    const home = tmp();
    write(path.join(home, '.cache/ok/blob'));
    write(configPath(home), JSON.stringify({ caches: [{ path: '/etc', risk: 'safe' }, { path: '~/.cache/ok', risk: 'safe' }, { nonsense: true }] }));
    const list = await listCustomCaches(home);
    assert.equal(list.length, 2);
    assert.match(list[0].problem ?? '', /outside your home folder/);
    assert.equal(list[1].problem, undefined);

    const findings = await custom.run(opts(home, { minBytes: 1 }), () => []);
    assert.deepEqual(findings.map((f) => f.id), ['custom:~/.cache/ok']);
  });
});

describe('custom cache findings', () => {
  it('become findings with the risk you gave and a delete action', async () => {
    const home = tmp();
    write(path.join(home, '.cache/safe-one/blob'));
    write(path.join(home, '.cache/review-one/blob'));
    await addCustomCache(home, '~/.cache/safe-one', { risk: 'safe', label: 'Safe one' });
    await addCustomCache(home, '~/.cache/review-one');
    const findings = (await scan(opts(home, { minBytes: 1, only: ['custom'] }))).findings;
    const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
    assert.equal(byId['custom:~/.cache/safe-one'].risk, 'safe');
    assert.match(byId['custom:~/.cache/safe-one'].title, /^Safe one/);
    assert.equal(byId['custom:~/.cache/review-one'].risk, 'review');
    assert.deepEqual(byId['custom:~/.cache/review-one'].actions.map((a) => a.kind.type), ['remove-path']);
  });

  it('are deleted only through the normal guarded fix, and only the one you pick', async () => {
    const home = tmp();
    write(path.join(home, '.cache/safe-one/blob'));
    write(path.join(home, '.cache/review-one/blob'));
    await addCustomCache(home, '~/.cache/safe-one', { risk: 'safe' });
    await addCustomCache(home, '~/.cache/review-one');
    const o = opts(home, { minBytes: 1, only: ['custom'] });

    const dry = await applyAction(o, 'custom:~/.cache/review-one#remove');
    assert.equal(dry.dryRun, true);
    assert.ok(existsSync(path.join(home, '.cache/review-one')));

    const done = await applyAction(o, 'custom:~/.cache/review-one#remove', true);
    assert.equal(done.ok, true);
    assert.ok(!existsSync(path.join(home, '.cache/review-one')));
    assert.ok(existsSync(path.join(home, '.cache/safe-one')));
  });

  it('are included in `fix safe` only when you marked them safe', async () => {
    const home = tmp();
    write(path.join(home, '.cache/safe-one/blob'));
    write(path.join(home, '.cache/review-one/blob'));
    await addCustomCache(home, '~/.cache/safe-one', { risk: 'safe' });
    await addCustomCache(home, '~/.cache/review-one');
    const batch = await applySafe(opts(home, { minBytes: 1, only: ['custom'] }), true);
    assert.equal(batch.ok, true);
    assert.ok(!existsSync(path.join(home, '.cache/safe-one')));
    assert.ok(existsSync(path.join(home, '.cache/review-one')));
  });

  it('do not duplicate a cache another detector already reports', async () => {
    const home = tmp();
    write(path.join(home, '.cache/uv/blob'));
    await addCustomCache(home, '~/.cache/uv', { risk: 'safe' });
    const res = await scan(opts(home, { minBytes: 1, only: ['pkgcaches', 'custom'] }));
    assert.deepEqual(res.findings.map((f) => f.id), ['pkgcaches:uv']);
  });

  it('are refused at delete time if the path stops being allowed', async () => {
    const home = tmp();
    write(path.join(home, 'Documents/keep/blob'));
    write(configPath(home), JSON.stringify({ caches: [{ path: '~/Documents', risk: 'safe' }] }));
    const o = opts(home, { minBytes: 1, only: ['custom'] });
    assert.deepEqual((await scan(o)).findings, []);
    const res = await applyAction(o, 'custom:~/Documents#remove', true);
    assert.equal(res.ok, false);
    assert.ok(existsSync(path.join(home, 'Documents/keep/blob')));
  });
});
