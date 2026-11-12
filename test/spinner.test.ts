import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startSpinner } from '../src/report/spinner.js';

function fakeStream(isTTY: boolean, columns?: number): { stream: { isTTY: boolean; columns?: number; write: (t: string) => void }; out: string[] } {
  const out: string[] = [];
  return { out, stream: { isTTY, columns, write: (t) => void out.push(t) } };
}

describe('spinner', () => {
  it('prints the message once and no frames when not on a terminal', async () => {
    const { stream, out } = fakeStream(false);
    const s = startSpinner('Scanning…', stream);
    await new Promise((r) => setTimeout(r, 200));
    s.stop();
    assert.deepEqual(out, ['Scanning…\n']);
  });

  it('animates on a terminal, then wipes its line and stays quiet after stop', async () => {
    const { stream, out } = fakeStream(true);
    const s = startSpinner('Scanning…', stream);
    await new Promise((r) => setTimeout(r, 250));
    s.stop();
    s.stop();
    const frames = out.filter((t) => t.includes('Scanning…'));
    assert.ok(frames.length >= 3, 'draws more than once');
    assert.notEqual(frames[0], frames[1], 'frames change');
    assert.equal(out.at(-1), '\r\x1b[K');
    const count = out.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(out.length, count, 'nothing drawn after stop');
  });

  it('never draws a line wider than the terminal, so each frame rewrites the same row', async () => {
    const columns = 30;
    const { stream, out } = fakeStream(true, columns);
    const s = startSpinner('Scanning (read-only)… this can take a minute on a big disk.', stream);
    await new Promise((r) => setTimeout(r, 150));
    s.stop();
    const frames = out.filter((t) => t.startsWith('\r\x1b[K') && t.length > '\r\x1b[K'.length);
    assert.ok(frames.length >= 2, 'draws more than once');
    for (const f of frames) {
      const line = f.slice('\r\x1b[K'.length);
      assert.ok(line.length < columns, `"${line}" must leave the last column free`);
    }
    assert.ok(frames[0]!.endsWith('…'), 'shows that the message was cut');
  });

  it('keeps the elapsed seconds visible when the message is cut', async () => {
    const { stream, out } = fakeStream(true, 20);
    const realNow = Date.now;
    const start = realNow();
    let now = start;
    Date.now = () => now;
    try {
      const s = startSpinner('A long message that will not fit', stream);
      now = start + 12_000;
      await new Promise((r) => setTimeout(r, 150));
      s.stop();
    } finally {
      Date.now = realNow;
    }
    const frames = out.filter((t) => t.includes('(12s)'));
    assert.ok(frames.length >= 1, 'shows the seconds');
    for (const f of frames) {
      assert.ok(f.slice('\r\x1b[K'.length).length < 20, 'still fits the row');
      assert.ok(f.endsWith(' (12s)'));
    }
  });
});
