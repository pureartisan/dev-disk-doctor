import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startSpinner } from '../src/report/spinner.js';

function fakeStream(isTTY: boolean): { stream: { isTTY: boolean; write: (t: string) => void }; out: string[] } {
  const out: string[] = [];
  return { out, stream: { isTTY, write: (t) => void out.push(t) } };
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
});
