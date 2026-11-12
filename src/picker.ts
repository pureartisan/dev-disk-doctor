import type { PlanItem } from './core/fix.js';
import { fmtBytes, isInside } from './core/util.js';

/** One tickable line: a runnable action on a finding. */
export interface Row {
  id: string;
  item: PlanItem;
  /** Safe on both the finding and the action, i.e. what `fix safe` would run. */
  safe: boolean;
  title: string;
  bytes: number;
}

/**
 * The checklist rows: the SAFE ones, which start ticked, come first so they are on the first screen, then the
 * REVIEW ones. Within each group the order of `items` (biggest first) is kept.
 */
export function buildRows(items: PlanItem[]): Row[] {
  const perFinding = new Map<string, number>();
  for (const { finding } of items) perFinding.set(finding.id, (perFinding.get(finding.id) ?? 0) + 1);
  const rows = items.map((item) => ({
    id: item.action.id,
    item,
    safe: item.finding.risk === 'safe' && item.action.risk === 'safe',
    // When one finding offers several actions, say which one this row is.
    title: perFinding.get(item.finding.id)! > 1 ? `${item.finding.title}: ${item.action.label}` : item.finding.title,
    bytes: item.finding.bytes,
  }));
  return [...rows.filter((r) => r.safe), ...rows.filter((r) => !r.safe)];
}

/**
 * The actions to run, in list order. A delete inside a folder that is also being deleted is dropped, since the
 * outer delete already removes it and the inner one would only report a failure.
 */
export function selectedPlan(rows: Row[], selected: ReadonlySet<string>): PlanItem[] {
  const chosen = rows.filter((r) => selected.has(r.id));
  const removed = chosen.flatMap((r) => (r.item.action.kind.type === 'remove-path' ? [r.item.action.kind.path] : []));
  return chosen
    .filter((r) => r.item.action.kind.type !== 'remove-path' || !removed.some((p) => p !== (r.item.action.kind as { path: string }).path && isInside((r.item.action.kind as { path: string }).path, p)))
    .map((r) => r.item);
}

export type KeyName = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'enter' | 'esc' | 'ctrl-c' | 'wheelup' | 'wheeldown' | 'click' | string;
export interface Key {
  name: KeyName;
  /** For clicks: the 1-based screen row. */
  y?: number;
}

const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g;
const CSI: Record<string, KeyName> = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[H': 'home', '\x1b[1~': 'home', '\x1b[F': 'end', '\x1b[4~': 'end', '\x1bOA': 'up', '\x1bOB': 'down' };

/** Turns what the terminal sent (keys, SGR mouse reports) into key names. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  for (const m of data.matchAll(TOKEN)) {
    const t = m[0];
    if (m[1] !== undefined) {
      const button = Number(m[1]);
      if (m[4] !== 'M') continue;
      if (button === 64) keys.push({ name: 'wheelup' });
      else if (button === 65) keys.push({ name: 'wheeldown' });
      else if (button === 0) keys.push({ name: 'click', y: Number(m[3]) });
    } else if (CSI[t]) keys.push({ name: CSI[t] });
    else if (t === '\r' || t === '\n') keys.push({ name: 'enter' });
    else if (t === '\x1b') keys.push({ name: 'esc' });
    else if (t === '\x03') keys.push({ name: 'ctrl-c' });
    else if (t.length === 1 && t >= ' ') keys.push({ name: t === ' ' ? 'space' : t });
  }
  return keys;
}

export interface PickerState {
  cursor: number;
  /** Index of the first visible row. */
  top: number;
  selected: Set<string>;
  screen: 'list' | 'confirm';
  done?: 'run' | 'cancel';
}

/** Lines above and below the rows: title, keys, a rule, and the position line. */
export const HEADER_LINES = 3;
export const FOOTER_LINES = 1;

export function viewHeight(screenRows: number): number {
  return Math.max(3, screenRows - HEADER_LINES - FOOTER_LINES);
}

/** SAFE rows start ticked, exactly what `fix safe` would run; REVIEW rows start unticked. */
export function initialState(rows: Row[]): PickerState {
  return { cursor: 0, top: 0, selected: new Set(rows.filter((r) => r.safe).map((r) => r.id)), screen: 'list' };
}

function follow(s: PickerState, count: number, view: number): PickerState {
  const cursor = Math.min(Math.max(0, s.cursor), Math.max(0, count - 1));
  let top = s.top;
  if (cursor < top) top = cursor;
  if (cursor >= top + view) top = cursor - view + 1;
  return { ...s, cursor, top: Math.max(0, Math.min(top, Math.max(0, count - view))) };
}

/** The next state after one key. Pure, so the checklist can be tested without a terminal. */
export function step(state: PickerState, key: Key, rows: Row[], view: number): PickerState {
  if (key.name === 'ctrl-c') return { ...state, done: 'cancel' };

  if (state.screen === 'confirm') {
    if (key.name === 'enter' || key.name === 'y') return { ...state, done: 'run' };
    if (key.name === 'q') return { ...state, done: 'cancel' };
    if (key.name === 'esc' || key.name === 'b' || key.name === 'n') return { ...state, screen: 'list' };
    return state;
  }

  const move = (to: number) => follow({ ...state, cursor: to }, rows.length, view);
  const toggle = (i: number): PickerState => {
    const r = rows[i];
    if (!r) return state;
    const selected = new Set(state.selected);
    if (selected.has(r.id)) selected.delete(r.id);
    else selected.add(r.id);
    return { ...state, selected };
  };

  switch (key.name) {
    case 'up':
    case 'k':
      return move(state.cursor - 1);
    case 'down':
    case 'j':
      return move(state.cursor + 1);
    case 'wheelup':
      return move(state.cursor - 3);
    case 'wheeldown':
      return move(state.cursor + 3);
    case 'pageup':
      return move(state.cursor - view);
    case 'pagedown':
      return move(state.cursor + view);
    case 'home':
    case 'g':
      return move(0);
    case 'end':
    case 'G':
      return move(rows.length - 1);
    case 'space':
    case 'x':
      return toggle(state.cursor);
    case 'click': {
      const i = state.top + (key.y ?? 0) - HEADER_LINES - 1;
      if (i < state.top || i >= Math.min(rows.length, state.top + view)) return state;
      return toggle(i) === state ? state : { ...toggle(i), cursor: i };
    }
    case 'a':
      return { ...state, selected: new Set(rows.map((r) => r.id)) };
    case 'n':
      return { ...state, selected: new Set() };
    case 's':
      return { ...state, selected: new Set(rows.filter((r) => r.safe).map((r) => r.id)) };
    case 'r': {
      const review = rows.filter((r) => !r.safe);
      const allOn = review.length > 0 && review.every((r) => state.selected.has(r.id));
      const selected = new Set(state.selected);
      for (const r of review) allOn ? selected.delete(r.id) : selected.add(r.id);
      return { ...state, selected };
    }
    case 'enter':
      return state.selected.size ? { ...state, screen: 'confirm' } : state;
    case 'q':
    case 'esc':
      return { ...state, done: 'cancel' };
    default:
      return state;
  }
}

export interface PickerStyle {
  color: boolean;
}

function paint(style: PickerStyle) {
  const c = (code: string) => (s: string) => (style.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { bold: c('1'), dim: c('2'), red: c('31'), green: c('32'), yellow: c('33'), cyan: c('36'), inverse: c('7') };
}

function fit(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Cut the middle out of `text` instead of the end. Titles share their start ("node_modules in ~/dev/...") and
 * differ at the end (the worktree name, "(idle 15d)"), so both ends are kept, with a bit more of the end.
 */
export function fitMiddle(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return '…'.slice(0, Math.max(0, width));
  const room = width - 1;
  const head = Math.floor(room * 0.35);
  return `${text.slice(0, head)}…${text.slice(text.length - (room - head))}`;
}

export function totals(rows: Row[], selected: ReadonlySet<string>): { count: number; bytes: number; review: number } {
  const chosen = rows.filter((r) => selected.has(r.id));
  return { count: chosen.length, bytes: chosen.reduce((n, r) => n + r.bytes, 0), review: chosen.filter((r) => !r.safe).length };
}

/** The whole screen as lines, each already cut to fit `columns`. */
export function renderPicker(state: PickerState, rows: Row[], size: { rows: number; columns: number }, style: PickerStyle): string[] {
  const p = paint(style);
  const view = viewHeight(size.rows);
  const t = totals(rows, state.selected);
  const summary = `${t.count} of ${rows.length} selected, about ${fmtBytes(t.bytes)}${t.review ? `, ${t.review} need a look` : ''}`;

  if (state.screen === 'confirm') {
    const lines = [p.bold(`Run ${t.count} action${t.count === 1 ? '' : 's'}? About ${fmtBytes(t.bytes)} will be cleaned.`), p.dim('Enter or y: run now   b or Esc: back   q: cancel'), ''];
    const reviews = rows.filter((r) => state.selected.has(r.id) && !r.safe);
    if (reviews.length) {
      lines.push(p.yellow(`${reviews.length} of these need a look first:`));
      for (const r of reviews.slice(0, Math.max(1, view - 8))) lines.push(`  ${p.yellow('•')} ${fitMiddle(r.title, size.columns - 6)}`);
      if (reviews.length > view - 8) lines.push(p.dim(`  … and ${reviews.length - Math.max(1, view - 8)} more`));
      lines.push('');
    }
    const warnings = [...new Set(selectedPlan(rows, state.selected).flatMap((i) => (i.action.warning ? [i.action.warning] : [])))];
    if (warnings.length) {
      lines.push(p.yellow('Check before you run this:'));
      for (const w of warnings.slice(0, 8)) lines.push(p.yellow(`  ! ${fit(w, size.columns - 6)}`));
    }
    return lines;
  }

  const lines = [
    p.bold(fit(`Pick what to clean: ${summary}`, size.columns)),
    p.dim(fit('↑↓ / wheel move · space or click tick · a all · n none · s SAFE only · r REVIEW on/off · enter continue · q quit', size.columns)),
    p.dim('─'.repeat(Math.max(1, Math.min(size.columns, 60)))),
  ];
  const titleWidth = Math.max(10, size.columns - 27);
  for (let i = state.top; i < Math.min(rows.length, state.top + view); i++) {
    const r = rows[i];
    const on = state.selected.has(r.id);
    const tag = r.safe ? p.green('SAFE  ') : p.yellow('REVIEW');
    const line = `${i === state.cursor ? p.cyan('>') : ' '} ${on ? p.green('[x]') : '[ ]'} ${p.bold(fmtBytes(r.bytes).padStart(8))}  ${tag}  ${fitMiddle(r.title, titleWidth)}`;
    lines.push(i === state.cursor ? p.inverse(line) : line);
  }
  lines.push(p.dim(`${rows.length ? state.cursor + 1 : 0}/${rows.length}${rows.length > view ? ' · scroll for more' : ''}`));
  return lines;
}

export interface Terminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h';
const LEAVE = '\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l';

/** Runs the checklist full-screen. Resolves with the ticked ids, or undefined if the person cancelled. */
export function runPicker(rows: Row[], term: Terminal, style: PickerStyle): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    const { stdin, stdout } = term;
    let state = initialState(rows);
    const size = () => ({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
    const draw = () => {
      stdout.write(`\x1b[H${renderPicker(state, rows, size(), style).map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`);
    };
    const restore = () => {
      stdout.write(LEAVE);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.off('resize', draw);
      process.off('exit', restore);
    };
    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        state = step(state, key, rows, viewHeight(size().rows));
        if (state.done) {
          restore();
          resolve(state.done === 'run' ? state.selected : undefined);
          return;
        }
      }
      draw();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', draw);
    // If the process dies mid-screen, still give the terminal back.
    process.on('exit', restore);
    stdout.write(ENTER);
    draw();
  });
}
