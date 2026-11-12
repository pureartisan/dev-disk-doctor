import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runnableActions, type PlanItem } from '../src/core/fix.js';
import type { Action, Finding, Risk } from '../src/core/types.js';
import { buildRows, fitMiddle, initialState, parseKeys, renderPicker, selectedPlan, step, viewHeight, type Key, type PickerState, type Row } from '../src/picker.js';

const MB = 1024 * 1024;

function act(id: string, risk: Risk, kind: Action['kind'] = { type: 'exec', file: 'true', args: [] }): Action {
  return { id, label: `do ${id}`, display: id, risk, kind };
}

function fin(id: string, risk: Risk, bytes: number, actions: Action[], title = id): Finding {
  return { id, detector: 'x', category: 'unknown', title, bytes, risk, regenerable: true, why: 'because', actions };
}

const findings: Finding[] = [
  fin('a', 'safe', 500 * MB, [act('a#go', 'safe')], 'Cache A'),
  fin('b', 'review', 300 * MB, [act('b#go', 'review')], 'Project B'),
  fin('c', 'safe', 200 * MB, [act('c#go', 'safe')], 'Cache C'),
  fin('logs', 'review', 900 * MB, [act('logs#protected', 'review', { type: 'manual' })], 'Logs'),
  fin('d', 'danger', 800 * MB, [act('d#go', 'danger')], 'Dangerous'),
  fin('e', 'review', 100 * MB, [act('e#go', 'danger')], 'Review finding, danger action'),
];

const rows = buildRows(runnableActions(findings));
const press = (s: PickerState, ...names: (string | Key)[]) => names.reduce<PickerState>((st, k) => step(st, typeof k === 'string' ? { name: k } : k, rows, 10), s);

describe('what the checklist offers', () => {
  it('never lists instructions-only or danger-rated items', () => {
    assert.deepEqual([...rows.map((r) => r.id)].sort(), ['a#go', 'b#go', 'c#go']);
  });

  it('lists the ticked SAFE rows first, then REVIEW rows, each biggest first', () => {
    assert.deepEqual(rows.map((r) => r.id), ['a#go', 'c#go', 'b#go']);
    const mixed = buildRows(
      runnableActions([
        fin('r1', 'review', 900 * MB, [act('r1#go', 'review')]),
        fin('s1', 'safe', 100 * MB, [act('s1#go', 'safe')]),
        fin('r2', 'review', 800 * MB, [act('r2#go', 'review')]),
        fin('s2', 'safe', 50 * MB, [act('s2#go', 'safe')]),
      ]),
    );
    assert.deepEqual(mixed.map((r) => r.id), ['s1#go', 's2#go', 'r1#go', 'r2#go']);
    const ticked = initialState(mixed).selected;
    assert.deepEqual(mixed.slice(0, ticked.size).map((r) => r.id), [...ticked].sort(), 'everything ticked at the start is at the top');
  });

  it('ticks SAFE rows and leaves REVIEW rows unticked to start', () => {
    assert.deepEqual([...initialState(rows).selected].sort(), ['a#go', 'c#go']);
  });

  it('names the action when a finding has several', () => {
    const multi = buildRows(runnableActions([fin('m', 'safe', MB, [act('m#one', 'safe'), act('m#two', 'safe')], 'Multi')]));
    assert.deepEqual(multi.map((r) => r.title), ['Multi: do m#one', 'Multi: do m#two']);
  });
});

describe('ticking', () => {
  it('toggles the row under the cursor and moves with the arrows and wheel', () => {
    let s = initialState(rows);
    s = press(s, 'down', 'down', 'space');
    assert.ok(s.selected.has('b#go'));
    s = press(s, 'space');
    assert.ok(!s.selected.has('b#go'));
    assert.equal(press(initialState(rows), 'wheeldown').cursor, 2, 'wheel stops at the last row');
    assert.equal(press(initialState(rows), 'up').cursor, 0, 'cannot go above the first row');
  });

  it('has presets for all, none, SAFE only, and REVIEW on and off', () => {
    const s = initialState(rows);
    assert.equal(press(s, 'a').selected.size, 3);
    assert.equal(press(s, 'n').selected.size, 0);
    assert.deepEqual([...press(s, 'a', 's').selected].sort(), ['a#go', 'c#go']);
    assert.ok(press(s, 'r').selected.has('b#go'));
    assert.ok(!press(s, 'r', 'r').selected.has('b#go'));
    assert.ok(press(s, 'r').selected.has('a#go'), 'REVIEW toggle leaves SAFE rows alone');
  });

  it('ticks the clicked row', () => {
    const s = press(initialState(rows), { name: 'click', y: 4 + 2 });
    assert.ok(s.selected.has('b#go'));
    assert.equal(s.cursor, 2);
    assert.equal(press(initialState(rows), { name: 'click', y: 1 }).selected.size, 2, 'a click on the header does nothing');
  });
});

describe('running', () => {
  it('asks for confirmation first, and goes back or cancels without running', () => {
    const s = press(initialState(rows), 'enter');
    assert.equal(s.screen, 'confirm');
    assert.equal(s.done, undefined);
    assert.equal(press(s, 'esc').screen, 'list');
    assert.equal(press(s, 'q').done, 'cancel');
    assert.equal(press(s, 'enter').done, 'run');
    assert.equal(press(initialState(rows), 'q').done, 'cancel');
    assert.equal(press(initialState(rows), 'ctrl-c').done, 'cancel');
  });

  it('does not continue with nothing ticked', () => {
    assert.equal(press(initialState(rows), 'n', 'enter').screen, 'list');
  });

  it('drops a delete that sits inside another delete being run', () => {
    const rm = (id: string, p: string): Row => ({
      id,
      safe: true,
      title: id,
      bytes: 1,
      item: { finding: fin(id, 'safe', 1, []), action: act(id, 'safe', { type: 'remove-path', path: p }) } as PlanItem,
    });
    const r = [rm('inner', '/h/proj/node_modules'), rm('outer', '/h/proj'), rm('other', '/h/other')];
    assert.deepEqual(selectedPlan(r, new Set(['inner', 'outer', 'other'])).map((i) => i.action.id), ['outer', 'other']);
    assert.deepEqual(selectedPlan(r, new Set(['inner'])).map((i) => i.action.id), ['inner']);
  });
});

describe('reading the terminal', () => {
  it('understands arrows, paging, enter, escape, space and mouse reports', () => {
    assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1b[5~\x1b[6~ \r').map((k) => k.name), ['up', 'down', 'pageup', 'pagedown', 'space', 'enter']);
    assert.deepEqual(parseKeys('\x1b'), [{ name: 'esc' }]);
    assert.deepEqual(parseKeys('\x1b[<64;10;5M\x1b[<65;10;5M').map((k) => k.name), ['wheelup', 'wheeldown']);
    assert.deepEqual(parseKeys('\x1b[<0;10;7M\x1b[<0;10;7m'), [{ name: 'click', y: 7 }], 'only the press counts');
    assert.deepEqual(parseKeys('as\x03').map((k) => k.name), ['a', 's', 'ctrl-c']);
  });
});

describe('drawing', () => {
  const style = { color: false };

  it('fits the screen and shows the totals, ticks and cursor', () => {
    const lines = renderPicker(initialState(rows), rows, { rows: 12, columns: 60 }, style);
    assert.ok(lines.every((l) => l.length <= 60));
    assert.match(lines[0], /2 of 3 selected, about 700 MB/);
    assert.match(lines.join('\n'), /> \[x\] +500 MB +SAFE +Cache A/);
    assert.match(lines.join('\n'), /\[ \] +300 MB +REVIEW +Project B/);
  });

  it('only draws the rows that fit and scrolls the cursor into view', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...rows[0], id: `r${i}`, title: `Row ${i}` }));
    const view = viewHeight(10);
    let s = initialState(many);
    for (let i = 0; i < 20; i++) s = step(s, { name: 'down' }, many, view);
    const lines = renderPicker(s, many, { rows: 10, columns: 80 }, style);
    assert.equal(lines.length, 3 + view + 1);
    assert.match(lines.join('\n'), /Row 20/);
    assert.doesNotMatch(lines.join('\n'), /Row 0\b/);
    assert.match(lines.at(-1)!, /21\/40/);
  });

  it('lists the REVIEW items and warnings on the confirm screen', () => {
    const warned: Finding[] = [fin('w', 'review', 50 * MB, [{ ...act('w#go', 'review'), warning: 'Quit the app first.' }], 'Warned thing')];
    const wrows = buildRows(runnableActions(warned));
    const s = step(step(initialState(wrows), { name: 'r' }, wrows, 10), { name: 'enter' }, wrows, 10);
    const out = renderPicker(s, wrows, { rows: 24, columns: 80 }, style).join('\n');
    assert.match(out, /Run 1 action\?/);
    assert.match(out, /Warned thing/);
    assert.match(out, /Quit the app first\./);
  });
});

describe('long titles', () => {
  const title = 'node_modules in ~/dev/clients/pm/pm-mobile-app/.claude/worktrees/catalogue-bitbucket-registry-64fbe1 (idle 15d)';

  it('cuts the middle and keeps both ends, to exactly the width', () => {
    const cut = fitMiddle(title, 70);
    assert.equal(cut.length, 70);
    assert.ok(cut.startsWith('node_modules in ~/dev/'));
    assert.ok(cut.endsWith('registry-64fbe1 (idle 15d)'), 'the part that tells rows apart survives');
    assert.ok(cut.includes('…'));
  });

  it('leaves a title that fits alone, and copes with tiny widths', () => {
    assert.equal(fitMiddle('short', 10), 'short');
    assert.equal(fitMiddle(title, 1), '…');
    assert.equal(fitMiddle(title, 0), '');
    assert.equal(fitMiddle(title, 2).length, 2);
  });

  it('shows the worktree name and idle age in the checklist rows', () => {
    const long = buildRows(runnableActions([fin('w', 'review', 4000 * MB, [act('w#go', 'review')], title)]));
    const lines = renderPicker(initialState(long), long, { rows: 12, columns: 80 }, { color: false });
    const row = lines.find((l) => l.includes('node_modules in'))!;
    assert.ok(row.endsWith('(idle 15d)'), row);
    assert.ok(row.length <= 80);
  });
});
