import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { configPath, hasRootsChoice, readConfig, resetConfig, saveAutoDiscover } from '../src/core/config.js';
import { askRoots, type Io } from '../src/prompt.js';
import { tmp, write } from './helpers.js';

const mk = (...p: string[]) => mkdirSync(path.join(...p), { recursive: true });

/** A scripted terminal: answers come from the list; running out behaves like a closed input. */
function fakeIo(answers: string[]): { io: Io; said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    said,
    asked,
    io: {
      say: (t) => said.push(t),
      ask: async (q) => {
        asked.push(q);
        const a = queue.shift();
        if (a === undefined) throw new Error('closed');
        return a;
      },
    },
  };
}

describe('first-run question', () => {
  it('does not ask when folders are saved, auto-detect was chosen, or the env var is set', async () => {
    const saved = tmp();
    mk(saved, 'code');
    write(configPath(saved), JSON.stringify({ roots: [path.join(saved, 'code')] }));
    const auto = tmp();
    await saveAutoDiscover(auto);
    const fresh = tmp();

    for (const [home, env] of [[saved, {}], [auto, {}], [fresh, { DEV_DISK_DOCTOR_ROOTS: '/x' }]] as const) {
      const t = fakeIo([]);
      assert.deepEqual(await askRoots(t.io, home, env), { roots: [] });
      assert.equal(t.asked.length, 0);
    }
    assert.equal(await hasRootsChoice(fresh, {}), false);
  });

  it('1 (or Enter) remembers "figure it out" and never asks again', async () => {
    for (const answer of ['1', '']) {
      const home = tmp();
      const t = fakeIo([answer]);
      assert.deepEqual(await askRoots(t.io, home, {}), { roots: [] });
      assert.deepEqual(await readConfig(home), { roots: [], autoDiscover: true, caches: [] });
      assert.equal(await hasRootsChoice(home, {}), true);
    }
  });

  it('2 saves the typed folders and uses them for this run', async () => {
    const home = tmp();
    mk(home, 'a');
    mk(home, 'b');
    const t = fakeIo(['2', '~/a, "~/b"']);
    const got = await askRoots(t.io, home, {});
    assert.deepEqual(got.roots, [path.join(home, 'a'), path.join(home, 'b')]);
    assert.deepEqual((await readConfig(home)).roots, got.roots);
  });

  it('3 uses the typed folders for this run only', async () => {
    const home = tmp();
    mk(home, 'a');
    const t = fakeIo(['3', '~/a']);
    assert.deepEqual((await askRoots(t.io, home, {})).roots, [path.join(home, 'a')]);
    assert.equal(await hasRootsChoice(home, {}), false);
  });

  it('4 skips without saving anything, so it asks again next time', async () => {
    const home = tmp();
    assert.deepEqual(await askRoots(fakeIo(['4']).io, home, {}), { roots: [] });
    assert.equal(await hasRootsChoice(home, {}), false);
  });

  it('re-asks on a bad folder and gives up on an empty answer', async () => {
    const home = tmp();
    mk(home, 'ok');
    const t = fakeIo(['2', '~/missing', '~/ok']);
    assert.deepEqual((await askRoots(t.io, home, {})).roots, [path.join(home, 'ok')]);
    assert.ok(t.said.some((s) => s.includes('is not a folder')));

    const t2 = fakeIo(['3', '']);
    assert.deepEqual(await askRoots(t2.io, tmp(), {}), { roots: [] });
  });

  it('treats a closed input or an unknown answer as skip', async () => {
    const home = tmp();
    assert.deepEqual(await askRoots(fakeIo([]).io, home, {}), { roots: [] });
    assert.deepEqual(await askRoots(fakeIo(['9']).io, home, {}), { roots: [] });
    assert.equal(await hasRootsChoice(home, {}), false);
  });

  it('keeps going when the choice cannot be saved', async () => {
    const home = tmp();
    mk(home, '.dev-disk-doctor');
    chmodSync(path.join(home, '.dev-disk-doctor'), 0o500); // readable, not writable
    try {
      const t = fakeIo(['1']);
      assert.deepEqual(await askRoots(t.io, home, {}), { roots: [] });
      assert.ok(t.said.some((s) => s.startsWith('Could not save')));
    } finally {
      chmodSync(path.join(home, '.dev-disk-doctor'), 0o700);
    }
  });

  it('reset forgets the choice so it asks again', async () => {
    const home = tmp();
    await saveAutoDiscover(home);
    await resetConfig(home);
    assert.equal(await hasRootsChoice(home, {}), false);
  });
});
