import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addSavedRoot, configPath, readSavedRoots, removeSavedRoot } from '../src/core/config.js';
import { defaultRoots } from '../src/core/roots.js';
import { tmp, write } from './helpers.js';

const mk = (...p: string[]) => mkdirSync(path.join(...p), { recursive: true });

describe('saved roots', () => {
  it('stores roots in ~/.dev-disk-doctor/config and reads them back', async () => {
    const home = tmp();
    mk(home, 'work/code');
    assert.deepEqual(await readSavedRoots(home), []);

    await addSavedRoot(home, '~/work/code');
    assert.equal(configPath(home), path.join(home, '.dev-disk-doctor', 'config'));
    assert.deepEqual(JSON.parse(readFileSync(configPath(home), 'utf8')), { roots: [path.join(home, 'work/code')] });
    assert.deepEqual(await readSavedRoots(home), [path.join(home, 'work/code')]);
  });

  it('does not save the same folder twice and can remove it again', async () => {
    const home = tmp();
    mk(home, 'a');
    mk(home, 'b');
    await addSavedRoot(home, '~/a');
    await addSavedRoot(home, path.join(home, 'a'));
    assert.deepEqual(await addSavedRoot(home, '~/b'), [path.join(home, 'a'), path.join(home, 'b')]);
    assert.deepEqual(await removeSavedRoot(home, '~/a'), [path.join(home, 'b')]);
    await assert.rejects(removeSavedRoot(home, '~/a'), /not in the saved list/);
  });

  it('refuses a missing folder, the filesystem root and the home folder', async () => {
    const home = tmp();
    await assert.rejects(addSavedRoot(home, '~/missing'), /is not a folder/);
    await assert.rejects(addSavedRoot(home, '/'), /filesystem root/);
    await assert.rejects(addSavedRoot(home, home), /whole home folder/);
    assert.deepEqual(await readSavedRoots(home), []);
  });

  it('reports a corrupt config instead of ignoring it', async () => {
    const home = tmp();
    write(configPath(home), '{ not json');
    await assert.rejects(readSavedRoots(home), /not valid JSON/);
  });

  it('treats an empty config file as no saved roots', async () => {
    const home = tmp();
    write(configPath(home), '');
    assert.deepEqual(await readSavedRoots(home), []);
  });
});

describe('defaultRoots with saved roots', () => {
  it('uses saved roots instead of auto-discovery', async () => {
    const home = tmp();
    mk(home, 'acme/api/.git'); // would be auto-discovered
    mk(home, 'elsewhere');
    await addSavedRoot(home, '~/elsewhere');
    assert.deepEqual(await defaultRoots(home, {}), [path.join(home, 'elsewhere')]);
  });

  it('lets DEV_DISK_DOCTOR_ROOTS win over saved roots', async () => {
    const home = tmp();
    mk(home, 'saved');
    mk(home, 'fromenv');
    await addSavedRoot(home, '~/saved');
    assert.deepEqual(await defaultRoots(home, { DEV_DISK_DOCTOR_ROOTS: '~/fromenv' }), [path.join(home, 'fromenv')]);
  });

  it('skips a saved folder that no longer exists but keeps it saved', async () => {
    const home = tmp();
    mk(home, 'gone');
    mk(home, 'kept');
    await addSavedRoot(home, '~/gone');
    await addSavedRoot(home, '~/kept');
    rmdirSync(path.join(home, 'gone'));
    assert.deepEqual(await defaultRoots(home, {}), [path.join(home, 'kept')]);
    assert.equal((await readSavedRoots(home)).length, 2);
  });

  it('goes back to auto-discovery once every saved root is removed', async () => {
    const home = tmp();
    mk(home, 'acme/api/.git');
    mk(home, 'elsewhere');
    await addSavedRoot(home, '~/elsewhere');
    await removeSavedRoot(home, '~/elsewhere');
    assert.deepEqual(await defaultRoots(home, {}), [path.join(home, 'acme')]);
  });
});
